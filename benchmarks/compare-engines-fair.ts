#!/usr/bin/env tsx
/**
 * Fair benchmark comparing mlx-engine and mlx-serving
 * BOTH load model once and reuse for all questions
 * Run: npx tsx benchmarks/compare-engines-fair.ts [config.yaml]
 *
 * Configuration is read from YAML file (default: benchmarks/compare-engines-fair.yaml)
 */

import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import readline from 'readline';
import YAML from 'yaml';

// Configuration types
interface BenchmarkConfig {
  benchmark: {
    max_tokens: number;
    temperature: number;
    timeout_ms: number;
  };
  models: Array<{
    name: string;
    size: string;
    questions: number;
    cycles: number;
    enabled: boolean;
  }>;
  questions: string[];
}

// Load configuration from YAML file
function loadConfig(configPath: string = 'benchmarks/compare-engines-fair.yaml'): BenchmarkConfig {
  try {
    const configFile = readFileSync(configPath, 'utf8');
    const config = YAML.parse(configFile) as BenchmarkConfig;

    // Validate configuration
    if (!config.benchmark || !config.models || !config.questions) {
      throw new Error('Invalid configuration: missing required fields');
    }

    if (config.models.length === 0) {
      throw new Error('No models defined in configuration');
    }

    if (config.questions.length === 0) {
      throw new Error('No questions defined in configuration');
    }

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${configPath}`);
    }
    throw error;
  }
}

// Global config - loaded in main()
let CONFIG: BenchmarkConfig;
let MAX_TOKENS: number;
let TEMP: number;
let SAMPLE_QUESTIONS: string[];
let REQUEST_TIMEOUT: number;

interface BenchmarkResult {
  engine: string;
  cycle: number;
  questions: number;
  totalTime: number;
  avgLatency: number;
  tokensPerSecond: number;
  successRate: number;
}

// Refactoring #4: Proper type definitions for better type safety
interface GenerateResponse {
  response: string;
  tokens: number;
  request_id?: number;
}

interface PendingRequest {
  resolve: (value: GenerateResponse) => void;
  reject: (reason: Error) => void;
  timeoutId: NodeJS.Timeout;
}

class MLXEngineServer {
  // Refactoring #2: Extract constants for better maintainability
  private static readonly MODEL_LOAD_TIMEOUT_MS = 600_000;  // 600 seconds (10 minutes for very large models 70B+)
  private static readonly PYTHON_VENV_PATH = '.mlx-engine-venv/bin/python';
  private static readonly SERVER_SCRIPT = 'benchmarks/mlx-engine-server.py';
  private static readonly MODEL_LOAD_STDERR_MARKER = 'ready for prompts';

  private static readonly ERROR_MESSAGES = {
    START_IN_PROGRESS: 'Start already in progress - wait for previous start() to complete',
    ALREADY_RUNNING: 'Server already running - call stop() first before starting again',
    SERVER_NOT_STARTED: 'Server not started',
    STREAM_VALIDATION_FAILED: 'Failed to create Python process streams',
    MODEL_LOAD_TIMEOUT: 'Model loading timeout (600s)',
    SERVER_STOPPED_DURING_LOAD: 'Server stopped during model loading',
    SERVER_STOPPED: 'Server stopped',
    REQUEST_TIMEOUT: 'Request timeout',
  } as const;

  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private lineHandler: ((line: string) => void) | null = null;  // Store handler to prevent listener leak
  // Refactoring #4: Use proper type instead of any
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private requestId = 0;
  private modelLoadTimeoutId: NodeJS.Timeout | null = null;  // Bug #7 fix: Track stderr timeout
  private processFailed: boolean = false;  // Bug #8 fix: Prevent double rejection
  private modelLoadReject: ((reason: any) => void) | null = null;  // Bug #9 fix: Reject on crash
  private stderrListener: ((data: Buffer) => void) | null = null;  // Bug #10 fix: Track stderr listener
  private isStarting: boolean = false;  // Bug #19 fix: Track if start() is in progress

  /**
   * Refactoring #3: Validates preconditions before starting the server
   *
   * Checks that:
   * - No start() operation is already in progress (Bug #19 fix)
   * - Server is not already running
   *
   * @throws {Error} If preconditions are not met
   */
  private validateStartPreconditions(): void {
    // Bug #19 fix: Prevent concurrent start() calls
    // Refactoring #2: Use constant for error message
    if (this.isStarting) {
      throw new Error(MLXEngineServer.ERROR_MESSAGES.START_IN_PROGRESS);
    }

    // Bug #19 fix: Prevent starting while already running
    // Refactoring #2: Use constant for error message
    if (this.process && !this.processFailed) {
      throw new Error(MLXEngineServer.ERROR_MESSAGES.ALREADY_RUNNING);
    }
  }

  /**
   * Refactoring #3: Spawns the Python MLX engine process
   *
   * Resets failure flag and spawns the Python subprocess using configured paths.
   * Bug #8 fix: Resets processFailed flag on each start
   */
  private spawnPythonProcess(): void {
    // Bug #8 fix: Reset failure flag on each start
    this.processFailed = false;

    // Refactoring #2: Use constants for paths
    this.process = spawn(MLXEngineServer.PYTHON_VENV_PATH, [MLXEngineServer.SERVER_SCRIPT]);
  }

  /**
   * Refactoring #3: Attaches error and exit handlers to the process
   *
   * Bug #14 fix: Handlers attached IMMEDIATELY after spawn, BEFORE stream validation.
   * This ensures the process is always monitored even if stream validation fails.
   * Bug #6 fix: Comprehensive error and exit handling
   */
  private attachProcessHandlers(): void {
    if (!this.process) return;

    // Bug #14 fix: Attach error handlers IMMEDIATELY after spawn, BEFORE stream validation
    // This ensures process is always monitored even if stream validation fails
    this.process.on('error', (error) => {
      console.error('Python process error:', error);
      this.handleProcessFailure(new Error(`Process error: ${error.message}`));
    });

    this.process.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Python process exited with code ${code}`);
        this.handleProcessFailure(new Error(`Process exited with code ${code}`));
      } else if (signal) {
        console.error(`Python process killed with signal ${signal}`);
        this.handleProcessFailure(new Error(`Process killed with signal ${signal}`));
      }
    });
  }

  /**
   * Refactoring #3: Validates that process streams exist
   *
   * Called AFTER error handlers are attached to ensure validation failures
   * don't leave an unmonitored process.
   *
   * @throws {Error} If stdin or stdout are not available
   */
  private validateProcessStreams(): void {
    // Now validate streams AFTER error handlers are attached
    // Refactoring #2: Use constant for error message
    if (!this.process?.stdout || !this.process?.stdin) {
      throw new Error(MLXEngineServer.ERROR_MESSAGES.STREAM_VALIDATION_FAILED);
    }
  }

  /**
   * Refactoring #3: Attaches error handlers to all process streams
   *
   * Bug #15 fix: stdin error handling
   * Bug #17 fix: stdout and stderr error handling
   * Refactoring #1: Uses extracted attachStreamErrorHandler() helper
   */
  private attachStreamHandlers(): void {
    if (!this.process) return;

    // Refactoring #1: Use extracted stream error handler helper
    // Bug #15 fix: Handle stdin stream errors (stream errors don't bubble to process)
    this.attachStreamErrorHandler(this.process.stdin!, 'stdin stream');
    // Bug #17 fix: Handle stdout stream errors
    this.attachStreamErrorHandler(this.process.stdout!, 'stdout stream');
    // Bug #17 fix: Handle stderr stream errors
    this.attachStreamErrorHandler(this.process.stderr!, 'stderr stream');
  }

  /**
   * Refactoring #3: Creates the response handler for stdout lines
   *
   * Handles:
   * - Request ID-based response matching (Bug #1 fix)
   * - FIFO fallback for backward compatibility
   * - Timeout cleanup (Bug #4 fix)
   * - Refactoring #6: Optimized map lookups
   *
   * @returns Handler function for processing response lines
   */
  private createResponseHandler(): (line: string) => void {
    return (line: string) => {
      try {
        const response = JSON.parse(line);
        // Match response by request ID (not FIFO - prevents mismatch after timeout)
        const requestId = response.request_id;
        // Refactoring #6: Optimize map lookup - single get() instead of has() + get()
        if (requestId !== undefined) {
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeoutId);  // Clear timer to prevent memory leak
            this.pendingRequests.delete(requestId);
            pending.resolve(response);
          }
        } else {
          // Fallback to FIFO for responses without ID (backward compat)
          const firstKey = this.pendingRequests.keys().next().value;
          if (firstKey !== undefined) {
            const pending = this.pendingRequests.get(firstKey);
            if (pending) {
              clearTimeout(pending.timeoutId);  // Clear timer to prevent memory leak
              this.pendingRequests.delete(firstKey);
              pending.resolve(response);
            }
          }
        }
      } catch (error) {
        console.error('Failed to parse response:', line);
      }
    };
  }

  /**
   * Refactoring #3: Sets up the readline interface for stdout parsing
   *
   * Creates readline interface, attaches error handler (Bug #18 fix),
   * and installs the response handler.
   */
  private setupReadlineInterface(): void {
    if (!this.process?.stdout) return;

    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    // Refactoring #1: Use extracted stream error handler helper
    // Bug #18 fix: Handle readline interface errors
    this.attachStreamErrorHandler(this.rl, 'readline interface');

    // Store handler to allow proper cleanup
    this.lineHandler = this.createResponseHandler();
    this.rl.on('line', this.lineHandler);
  }

  /**
   * Refactoring #3: Waits for the model to load with timeout
   *
   * Sends model name to Python process and waits for "ready for prompts" message.
   * Bug #7 fix: Tracks timeout ID for cleanup
   * Bug #9 fix: Tracks reject function for crash handling
   * Bug #10 fix: Tracks stderr listener for cleanup
   *
   * @param model - Model identifier to load
   * @throws {Error} If model loading times out or fails
   */
  private async waitForModelLoad(model: string): Promise<void> {
    if (!this.process) return;

    // Send model name
    this.process.stdin!.write(model + '\n');

    // Wait for "Model loaded" message with timeout
    await new Promise<void>((resolve, reject) => {
      // Bug #9 fix: Store reject to allow cleanup on crash
      this.modelLoadReject = reject;
      let resolved = false;

      // Bug #10 fix: Store stderr listener for proper cleanup
      this.stderrListener = (data: Buffer) => {
        const message = data.toString();
        // Refactoring #2: Use constant for stderr marker
        if (message.includes(MLXEngineServer.MODEL_LOAD_STDERR_MARKER)) {
          resolved = true;
          this.process!.stderr!.off('data', this.stderrListener!);
          this.stderrListener = null;  // Bug #10 fix: Clear listener reference
          this.modelLoadReject = null;  // Bug #9 fix: Clear reject reference

          // Bug #7 fix: Clear timeout when model loads successfully
          if (this.modelLoadTimeoutId) {
            clearTimeout(this.modelLoadTimeoutId);
            this.modelLoadTimeoutId = null;
          }

          resolve();
        }
      };
      this.process!.stderr!.on('data', this.stderrListener);

      // Bug #7 fix: Store timeout ID for proper cleanup
      // Refactoring #2: Use constant for timeout value and error message
      this.modelLoadTimeoutId = setTimeout(() => {
        if (!resolved) {
          this.process!.stderr!.off('data', this.stderrListener!);
          this.stderrListener = null;  // Bug #10 fix: Clear listener reference
          this.modelLoadReject = null;  // Bug #9 fix: Clear reject reference
          this.modelLoadTimeoutId = null;
          reject(new Error(MLXEngineServer.ERROR_MESSAGES.MODEL_LOAD_TIMEOUT));
        }
      }, MLXEngineServer.MODEL_LOAD_TIMEOUT_MS);
    });

    // Bug #9 & #10 fix: Clear references after successful load
    this.modelLoadReject = null;
    this.stderrListener = null;
  }

  /**
   * Starts the MLX engine server and loads the specified model
   *
   * This is the main entry point for initializing the server. It orchestrates
   * the entire startup sequence using extracted helper methods (Refactoring #3).
   *
   * Startup sequence:
   * 1. Validate preconditions (no concurrent starts, not already running)
   * 2. Spawn Python subprocess
   * 3. Attach process error/exit handlers
   * 4. Validate process streams exist
   * 5. Attach stream error handlers
   * 6. Setup readline interface
   * 7. Wait for model to load
   *
   * Bug #19 fix: Prevents concurrent start() calls with isStarting flag
   *
   * @param model - Model identifier to load (e.g., "mlx-community/Qwen2.5-14B-Instruct-4bit")
   * @throws {Error} If server is already running or starting
   * @throws {Error} If model loading fails or times out
   */
  async start(model: string): Promise<void> {
    // Refactoring #3: Use extracted validation method
    this.validateStartPreconditions();

    // Bug #19 fix: Set flag to block concurrent calls
    this.isStarting = true;

    try {
      // Refactoring #3: Use extracted methods for process setup
      this.spawnPythonProcess();
      this.attachProcessHandlers();
      this.validateProcessStreams();
      this.attachStreamHandlers();
      this.setupReadlineInterface();
      await this.waitForModelLoad(model);

      // Bug #19 fix: Clear flag on success
      this.isStarting = false;
    } catch (error) {
      // Bug #19 fix: Clear flag on error
      this.isStarting = false;
      throw error;
    }
  }

  /**
   * Handles catastrophic process failures (crashes, unexpected exits)
   *
   * This is the central error handler called when the Python process fails.
   * It performs comprehensive cleanup to prevent resource leaks and ensure
   * all pending promises are properly rejected.
   *
   * Bug #8 fix: Guards against multiple calls since both 'error' and 'exit' events can fire
   * Bug #19 fix: Resets isStarting flag to allow restart after failure
   *
   * Cleanup sequence:
   * 1. Mark process as failed (prevent duplicate handling)
   * 2. Clean up all stream error listeners (Refactoring #5)
   * 3. Clean up stderr listener (Refactoring #5)
   * 4. Clean up readline interface (Refactoring #5)
   * 5. Reject model loading promise if pending
   * 6. Clear model load timeout
   * 7. Reject all pending generate() requests
   * 8. Remove process event listeners
   * 9. Clear process reference
   *
   * @param error - The error that caused the process failure
   */
  private handleProcessFailure(error: Error): void {
    // Bug #8 fix: Guard against multiple calls (both 'error' and 'exit' can fire)
    if (this.processFailed) {
      return;  // Already handled, skip to prevent double rejection
    }
    this.processFailed = true;
    this.isStarting = false;  // Bug #19 fix: Reset flag on failure

    // Refactoring #5: Use extracted cleanup methods
    this.cleanupStreamErrorListeners();
    this.cleanupStderrListener();
    this.cleanupReadlineInterface();

    // Refactoring #4: Use extracted cleanup methods
    this.cleanupModelLoadPromise(error);
    this.rejectAllPendingRequests(error);
    this.cleanupProcessListeners();
  }

  /**
   * Generates text using the loaded model
   *
   * Sends a generation request to the Python MLX engine and waits for the response.
   * Uses request ID-based matching to handle responses correctly (Bug #1 fix).
   *
   * Bug #16 fix: Captures process reference atomically to avoid TOCTOU race condition
   * Bug #4 fix: Includes timeout with cleanup to prevent memory leaks
   *
   * @param prompt - The text prompt to generate from
   * @param maxTokens - Maximum number of tokens to generate
   * @param temp - Temperature for sampling (0.0 = deterministic, higher = more random)
   * @returns Promise resolving to object with token count
   * @throws {Error} If server is not started
   * @throws {Error} If request times out (300s default)
   */
  async generate(prompt: string, maxTokens: number, temp: number): Promise<{ tokens: number }> {
    // Bug #16 fix: Capture process reference atomically to avoid TOCTOU race
    // Between check and use, this.process could become null if process crashes
    const process = this.process;
    const stdin = process?.stdin;

    // Refactoring #2: Use constant for error message
    if (!process || !stdin) {
      throw new Error(MLXEngineServer.ERROR_MESSAGES.SERVER_NOT_STARTED);
    }

    const id = this.requestId++;
    const request = {
      request_id: id,  // Add ID to request for proper matching
      prompt,
      max_tokens: maxTokens,
      temp,
    };

    return new Promise((resolve, reject) => {
      // Create timeout and store handle to prevent memory leak
      // Refactoring #2: Use constant for error message
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(new Error(MLXEngineServer.ERROR_MESSAGES.REQUEST_TIMEOUT));
        }
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
      // Use captured stdin reference (safe even if this.process becomes null)
      stdin.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Refactoring #1: Attaches error handler to a stream or interface
   *
   * Extracted helper to eliminate duplication of error handler code.
   * Used for stdin, stdout, stderr, and readline interface.
   *
   * Bug #15 fix: Ensures stdin errors are handled
   * Bug #17 fix: Ensures stdout/stderr errors are handled
   * Bug #18 fix: Ensures readline interface errors are handled
   *
   * @param stream - The stream or interface to attach error handler to
   * @param streamName - Human-readable name for error messages
   */
  private attachStreamErrorHandler(
    stream: NodeJS.ReadableStream | NodeJS.WritableStream | readline.Interface,
    streamName: string
  ): void {
    stream.on('error', (error) => {
      console.error(`${streamName} error:`, error);
      this.handleProcessFailure(new Error(`${streamName} error: ${error.message}`));
    });
  }

  /**
   * Refactoring #5: Cleans up all stream error listeners
   *
   * Removes error listeners from stdin, stdout, and stderr streams.
   * Called during shutdown and process failure to prevent listener leaks.
   *
   * Bug #15 fix: Removes stdin error listener
   * Bug #17 fix: Removes stdout/stderr error listeners
   */
  private cleanupStreamErrorListeners(): void {
    // Bug #15 fix: Remove stdin error listener if still attached
    if (this.process?.stdin) {
      this.process.stdin.removeAllListeners('error');
    }

    // Bug #17 fix: Remove stdout error listener if still attached
    if (this.process?.stdout) {
      this.process.stdout.removeAllListeners('error');
    }

    // Bug #17 fix: Remove stderr error listener if still attached
    if (this.process?.stderr) {
      this.process.stderr.removeAllListeners('error');
    }
  }

  /**
   * Refactoring #5: Cleans up stderr data listener
   *
   * Removes the stderr listener used during model loading.
   * Called during shutdown and process failure to prevent listener leaks.
   *
   * Bug #10 fix: Tracks and removes stderr listener properly
   */
  private cleanupStderrListener(): void {
    // Bug #10 fix: Remove stderr data listener if still attached
    if (this.stderrListener && this.process?.stderr) {
      this.process.stderr.off('data', this.stderrListener);
      this.stderrListener = null;
    }
  }

  /**
   * Refactoring #5: Cleans up readline interface
   *
   * Removes error listener, line handler, and closes the interface.
   * Called during shutdown and process failure to prevent resource leaks.
   *
   * Bug #11 fix: Removes line handler properly
   * Bug #12 fix: Closes readline interface to release resources
   * Bug #18 fix: Removes readline error listener
   */
  private cleanupReadlineInterface(): void {
    // Bug #18 fix: Remove readline error listener if still attached
    if (this.rl) {
      this.rl.removeAllListeners('error');
    }

    // Bug #11 fix: Remove stdout lineHandler if still attached
    if (this.rl && this.lineHandler) {
      this.rl.off('line', this.lineHandler);
      this.lineHandler = null;
    }

    // Bug #12 fix: Close readline interface to release resources
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Refactoring #4: Cleans up model loading promise and timeout
   *
   * Rejects the model loading promise if pending and clears the timeout.
   * Called during shutdown and process failure to prevent promise leaks.
   *
   * Bug #9 fix: Properly rejects model load promise
   * Bug #7 fix: Clears model load timeout
   *
   * @param error - Optional error to reject the promise with
   */
  private cleanupModelLoadPromise(error?: Error): void {
    // Bug #9 fix: Reject model loading promise if still waiting
    if (this.modelLoadReject) {
      this.modelLoadReject(error || new Error(MLXEngineServer.ERROR_MESSAGES.SERVER_STOPPED_DURING_LOAD));
      this.modelLoadReject = null;
    }

    // Bug #7 fix: Clear model load timeout if still active
    if (this.modelLoadTimeoutId) {
      clearTimeout(this.modelLoadTimeoutId);
      this.modelLoadTimeoutId = null;
    }
  }

  /**
   * Refactoring #4: Rejects all pending generate() requests
   *
   * Clears timeouts and rejects all pending requests with the given error.
   * Called during shutdown and process failure to prevent request leaks.
   *
   * Bug #4 fix: Clears timeouts to prevent memory leaks
   *
   * @param error - Error to reject all pending requests with
   */
  private rejectAllPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Refactoring #4: Cleans up process event listeners
   *
   * Removes all process event listeners and clears process reference.
   * Called during shutdown and process failure to prevent listener leaks.
   *
   * Bug #8 fix: Removes listeners to prevent further calls
   * Bug #13 fix: Clears reference to dead process
   * Bug #20 fix: Consolidated cleanup - handles both error handlers and kill
   *
   * @param killProcess - If true, kills the process before cleanup (used during stop())
   */
  private cleanupProcessListeners(killProcess: boolean = false): void {
    if (this.process) {
      this.process.removeAllListeners('error');
      this.process.removeAllListeners('exit');

      // Bug #20 fix: Optionally kill process during graceful shutdown
      if (killProcess) {
        this.process.kill();
      }

      this.process = null;
    }
  }

  /**
   * Stops the MLX engine server and cleans up all resources
   *
   * Performs graceful shutdown of the Python process and ensures all
   * resources are properly released and promises are properly rejected.
   *
   * Bug #8 fix: Sets processFailed flag to prevent handleProcessFailure during shutdown
   * Bug #19 fix: Resets isStarting flag
   * Bug #20 fix: Uses cleanupProcessListeners() helper to eliminate duplication
   *
   * Cleanup sequence:
   * 1. Set processFailed flag (prevent error handler from firing)
   * 2. Clean up all stream error listeners (Refactoring #5)
   * 3. Clean up stderr listener (Refactoring #5)
   * 4. Reject model loading promise if pending
   * 5. Clear model load timeout
   * 6. Reject all pending generate() requests
   * 7. Clean up readline interface (Refactoring #5)
   * 8. Kill process and remove listeners (Refactoring #4)
   */
  async stop(): Promise<void> {
    // Bug #8 fix: Set flag to prevent handleProcessFailure from firing during shutdown
    this.processFailed = true;
    this.isStarting = false;  // Bug #19 fix: Reset flag on stop

    // Refactoring #5: Use extracted cleanup methods
    this.cleanupStreamErrorListeners();
    this.cleanupStderrListener();
    this.cleanupReadlineInterface();

    // Refactoring #4: Use extracted cleanup methods
    this.cleanupModelLoadPromise(new Error(MLXEngineServer.ERROR_MESSAGES.SERVER_STOPPED_DURING_LOAD));
    this.rejectAllPendingRequests(new Error(MLXEngineServer.ERROR_MESSAGES.SERVER_STOPPED));

    // Bug #20 fix: Use cleanupProcessListeners() helper (with kill=true)
    this.cleanupProcessListeners(true);
  }
}

function generateQuestions(count: number): string[] {
  const questions: string[] = [];
  for (let i = 0; i < count; i++) {
    questions.push(SAMPLE_QUESTIONS[i % SAMPLE_QUESTIONS.length]);
  }
  return questions;
}

/**
 * Refactoring #5: Calculates benchmark result from timing and token data
 *
 * Extracted helper to eliminate duplication between MLX Engine and MLX Serving benchmarks.
 * Ensures consistent calculation logic across both engines.
 *
 * @param engine - Engine name ('mlx-engine' or 'mlx-serving')
 * @param cycle - Cycle number
 * @param questionCount - Total number of questions
 * @param totalTokens - Total tokens generated
 * @param successCount - Number of successful requests
 * @param startTime - Start timestamp in milliseconds
 * @param endTime - End timestamp in milliseconds
 * @returns Calculated benchmark result
 */
function calculateBenchmarkResult(
  engine: string,
  cycle: number,
  questionCount: number,
  totalTokens: number,
  successCount: number,
  startTime: number,
  endTime: number
): BenchmarkResult {
  const totalTime = Math.max((endTime - startTime) / 1000, 0.001);  // Minimum 1ms to avoid division by zero
  const avgLatency = questionCount > 0 ? totalTime / questionCount : 0;
  const tokensPerSecond = totalTime > 0 ? totalTokens / totalTime : 0;
  const successRate = questionCount > 0 ? (successCount / questionCount) * 100 : 0;

  return {
    engine,
    cycle,
    questions: questionCount,
    totalTime,
    avgLatency,
    tokensPerSecond,
    successRate,
  };
}

async function benchmarkMLXEngine(cycle: number, server: MLXEngineServer, questionCount: number): Promise<BenchmarkResult> {
  console.log(`\n[mlx-engine] Starting cycle ${cycle}...`);

  const questions = generateQuestions(questionCount);
  const startTime = Date.now();
  let totalTokens = 0;
  let successCount = 0;

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    process.stdout.write(`\r[mlx-engine] Progress: ${i + 1}/${questionCount}`);

    try {
      const result = await server.generate(question, MAX_TOKENS, TEMP);
      totalTokens += result.tokens;
      successCount++;
    } catch (error) {
      console.error(`\nError on question ${i + 1}:`, error);
    }
  }

  const endTime = Date.now();

  // Refactoring #5: Use extracted calculation helper
  const benchmarkResult = calculateBenchmarkResult(
    'mlx-engine',
    cycle,
    questionCount,
    totalTokens,
    successCount,
    startTime,
    endTime
  );

  console.log(`\n[mlx-engine] Cycle ${cycle} complete: ${benchmarkResult.tokensPerSecond.toFixed(2)} tok/s`);

  return benchmarkResult;
}

async function benchmarkMLXServing(cycle: number, engine: any, model: string, questionCount: number): Promise<BenchmarkResult> {
  console.log(`\n[mlx-serving] Starting cycle ${cycle}...`);

  const questions = generateQuestions(questionCount);
  let totalTokens = 0;
  let successCount = 0;

  const startTime = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    process.stdout.write(`\r[mlx-serving] Progress: ${i + 1}/${questionCount}`);

    try {
      let tokenCount = 0;
      for await (const chunk of engine.createGenerator({
        model,
        prompt: question,
        maxTokens: MAX_TOKENS,
        temperature: TEMP,
      })) {
        if (chunk.type === 'token') {
          tokenCount++;
        }
      }
      totalTokens += tokenCount;
      successCount++;
    } catch (error) {
      console.error(`\nError on question ${i + 1}:`, error);
    }
  }

  const endTime = Date.now();

  // Refactoring #5: Use extracted calculation helper
  const benchmarkResult = calculateBenchmarkResult(
    'mlx-serving',
    cycle,
    questionCount,
    totalTokens,
    successCount,
    startTime,
    endTime
  );

  console.log(`\n[mlx-serving] Cycle ${cycle} complete: ${benchmarkResult.tokensPerSecond.toFixed(2)} tok/s`);

  return benchmarkResult;
}

function calculateAverage(results: BenchmarkResult[]): BenchmarkResult {
  if (results.length === 0) {
    throw new Error('Cannot calculate average: no benchmark results available');
  }

  const totalTokensPerSec = results.reduce((sum, r) => sum + r.tokensPerSecond, 0);
  const totalLatency = results.reduce((sum, r) => sum + r.avgLatency, 0);
  const totalTime = results.reduce((sum, r) => sum + r.totalTime, 0);
  const totalSuccessRate = results.reduce((sum, r) => sum + r.successRate, 0);

  const length = Math.max(results.length, 1);  // Extra safety against division by zero

  return {
    engine: results[0].engine,
    cycle: 0,
    questions: results[0].questions,
    totalTime: totalTime / length,
    avgLatency: totalLatency / length,
    tokensPerSecond: totalTokensPerSec / length,
    successRate: totalSuccessRate / length,
  };
}

async function main() {
  // Load configuration from YAML file (default or from command line argument)
  const configPath = process.argv[2] || 'benchmarks/compare-engines-fair.yaml';
  console.log(`\n📋 Loading configuration from: ${configPath}\n`);

  try {
    CONFIG = loadConfig(configPath);
  } catch (error) {
    console.error('❌ Failed to load configuration:', (error as Error).message);
    console.error('\nUsage: npx tsx benchmarks/compare-engines-fair.ts [config.yaml]');
    process.exit(1);
  }

  // Set global variables from config
  MAX_TOKENS = CONFIG.benchmark.max_tokens;
  TEMP = CONFIG.benchmark.temperature;
  SAMPLE_QUESTIONS = CONFIG.questions;
  REQUEST_TIMEOUT = CONFIG.benchmark.timeout_ms;

  // Filter enabled models
  const enabledModels = CONFIG.models.filter(m => m.enabled);

  if (enabledModels.length === 0) {
    console.error('❌ No enabled models found in configuration');
    process.exit(1);
  }

  // Validate model configurations
  for (const model of enabledModels) {
    if (model.questions <= 0) {
      console.error(`❌ Invalid configuration: ${model.name} has questions <= 0`);
      process.exit(1);
    }
    if (model.cycles <= 0) {
      console.error(`❌ Invalid configuration: ${model.name} has cycles <= 0`);
      process.exit(1);
    }
  }

  console.log('='.repeat(60));
  console.log('Fair Benchmark - mlx-engine vs mlx-serving');
  console.log('(Both engines load model once, reuse for all questions)');
  console.log('='.repeat(60));
  console.log(`Models to benchmark: ${enabledModels.length}`);
  enabledModels.forEach(m => {
    console.log(`  • ${m.name} (${m.size}) - ${m.questions} questions × ${m.cycles} cycles`);
  });
  console.log(`Max Tokens: ${MAX_TOKENS}`);
  console.log(`Temperature: ${TEMP}`);
  console.log(`Request Timeout: ${REQUEST_TIMEOUT / 1000}s`);
  console.log('='.repeat(60));

  // Loop through each enabled model
  for (const modelConfig of enabledModels) {
    const { name: MODEL, size, questions: QUESTIONS, cycles: CYCLES } = modelConfig;

    console.log('\n\n' + '🔷'.repeat(30));
    console.log(`\n🎯 BENCHMARKING MODEL: ${MODEL} (${size})\n`);
    console.log('🔷'.repeat(30));

    const mlxEngineResults: BenchmarkResult[] = [];
    const mlxServingResults: BenchmarkResult[] = [];

    // Benchmark mlx-engine
    console.log('\n\n📊 Benchmarking mlx-engine (persistent server)...\n');
    console.log('Loading model...');
    const mlxEngineServer = new MLXEngineServer();
    await mlxEngineServer.start(MODEL);
    console.log('Model loaded! Starting cycles...\n');

    for (let i = 1; i <= CYCLES; i++) {
      const result = await benchmarkMLXEngine(i, mlxEngineServer, QUESTIONS);
      mlxEngineResults.push(result);
    }

    await mlxEngineServer.stop();

    // Benchmark mlx-serving
    console.log('\n\n📊 Benchmarking mlx-serving...\n');
    console.log('Loading model...');
    const { createEngine } = await import('../dist/index.js');
    const mlxServingEngine = await createEngine();
    await mlxServingEngine.loadModel({ model: MODEL });
    console.log('Model loaded! Starting cycles...\n');

    for (let i = 1; i <= CYCLES; i++) {
      const result = await benchmarkMLXServing(i, mlxServingEngine, MODEL, QUESTIONS);
      mlxServingResults.push(result);
    }

    await mlxServingEngine.dispose();

    // Calculate averages
    const mlxEngineAvg = calculateAverage(mlxEngineResults);
    const mlxServingAvg = calculateAverage(mlxServingResults);

    // Print results
    console.log('\n\n' + '='.repeat(60));
    console.log(`BENCHMARK RESULTS: ${MODEL} (${size})`);
    console.log('='.repeat(60));

    console.log('\n📈 mlx-engine (Python - Model Loaded Once)');
    console.log('-'.repeat(60));
    mlxEngineResults.forEach((r) => {
      console.log(`Cycle ${r.cycle}: ${r.tokensPerSecond.toFixed(2)} tok/s | ${r.avgLatency.toFixed(2)}s latency | ${r.successRate.toFixed(1)}% success`);
    });
    console.log('-'.repeat(60));
    console.log(`Average: ${mlxEngineAvg.tokensPerSecond.toFixed(2)} tok/s | ${mlxEngineAvg.avgLatency.toFixed(2)}s latency | ${mlxEngineAvg.successRate.toFixed(1)}% success`);

    console.log('\n📈 mlx-serving (TypeScript - Model Loaded Once)');
    console.log('-'.repeat(60));
    mlxServingResults.forEach((r) => {
      console.log(`Cycle ${r.cycle}: ${r.tokensPerSecond.toFixed(2)} tok/s | ${r.avgLatency.toFixed(2)}s latency | ${r.successRate.toFixed(1)}% success`);
    });
    console.log('-'.repeat(60));
    console.log(`Average: ${mlxServingAvg.tokensPerSecond.toFixed(2)} tok/s | ${mlxServingAvg.avgLatency.toFixed(2)}s latency | ${mlxServingAvg.successRate.toFixed(1)}% success`);

    // Comparison
    const improvement = mlxEngineAvg.tokensPerSecond > 0
      ? ((mlxServingAvg.tokensPerSecond / mlxEngineAvg.tokensPerSecond - 1) * 100)
      : 0;  // Avoid division by zero
    console.log('\n🔄 Comparison (Fair: Both Reuse Loaded Model)');
    console.log('-'.repeat(60));
    console.log(`mlx-serving vs mlx-engine: ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%`);
    console.log(`Throughput: ${mlxServingAvg.tokensPerSecond.toFixed(2)} vs ${mlxEngineAvg.tokensPerSecond.toFixed(2)} tok/s`);
    console.log(`Latency: ${mlxServingAvg.avgLatency.toFixed(2)} vs ${mlxEngineAvg.avgLatency.toFixed(2)} seconds`);

    // Save results for this model
    mkdirSync('results', { recursive: true });
    const results = {
      timestamp: new Date().toISOString(),
      benchmark_type: 'fair_comparison',
      note: 'Both engines load model once and reuse for all questions',
      config_file: configPath,
      model: MODEL,
      modelSize: size,
      questions: QUESTIONS,
      cycles: CYCLES,
      maxTokens: MAX_TOKENS,
      temperature: TEMP,
      mlxEngine: {
        cycles: mlxEngineResults,
        average: mlxEngineAvg,
      },
      mlxServing: {
        cycles: mlxServingResults,
        average: mlxServingAvg,
      },
      comparison: {
        improvement: improvement,
        winner: improvement > 0 ? 'mlx-serving' : 'mlx-engine',
      },
    };

    const outputFile = join('results', `fair-comparison-${Date.now()}.json`);
    writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results saved to: ${outputFile}`);
    console.log('='.repeat(60));
  }

  console.log('\n\n' + '✅'.repeat(30));
  console.log(`🎉 ALL ${enabledModels.length} MODEL BENCHMARK${enabledModels.length > 1 ? 'S' : ''} COMPLETED!`);
  console.log('✅'.repeat(30));
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
