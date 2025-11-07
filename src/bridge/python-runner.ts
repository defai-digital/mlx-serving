/**
 * Python Runtime Process Manager
 *
 * Manages the lifecycle of the Python MLX runtime process:
 * - Spawns and maintains persistent Python process
 * - Handles process crashes and restarts
 * - Monitors health and memory usage
 * - Graceful shutdown
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import { StreamRegistry } from './stream-registry.js';
import { JsonRpcTransport } from './jsonrpc-transport.js';
import { getConfig } from '../config/loader.js';
import {
  StreamChunkNotificationSchema,
  StreamStatsNotificationSchema,
  StreamEventNotificationSchema,
  RuntimeInfoResponseSchema,
} from './serializers.js';
import type { RuntimeInfoResponse } from './serializers.js';
// OPTIMIZATION #1: Fast validators for high-frequency paths
import {
  fastValidateStreamChunk,
  fastValidateStreamStats,
  fastValidateStreamEvent,
  shouldUseFastValidation,
} from './fast-validators.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PythonRunnerOptions {
  /**
   * Path to Python executable (defaults to .kr-mlx-venv/bin/python)
   */
  pythonPath?: string;

  /**
   * Path to runtime.py script
   */
  runtimePath?: string;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Maximum restarts on crash (default: 3)
   */
  maxRestarts?: number;

  /**
   * Timeout for process startup (ms, default: 30000)
   */
  startupTimeout?: number;

  /**
   * Memory usage threshold in bytes (default: 512MB)
   * Triggers memory-warning event when exceeded
   */
  memoryThreshold?: number;

  /**
   * Memory monitoring interval in ms (default: 60000 = 1 minute)
   * Set to 0 to disable memory monitoring
   */
  memoryMonitoringInterval?: number;

  /**
   * Logger instance
   */
  logger?: Logger;
}

export interface RuntimeInfo {
  pid: number;
  uptime: number;
  memoryUsage: number;
  status: 'starting' | 'ready' | 'error' | 'stopped';
}

export interface MemoryWarning {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  threshold: number;
}

export type PythonRunnerEvents = {
  ready: () => void;
  error: (error: Error) => void;
  restart: (attempt: number) => void;
  exit: (code: number | null) => void;
  stderr: (data: string) => void;
  'memory-warning': (warning: MemoryWarning) => void;
};

export class PythonRunner extends EventEmitter<PythonRunnerEvents> {
  private process: ChildProcess | null = null;
  private status: RuntimeInfo['status'] = 'stopped';
  private startTime: number = 0;
  private restartCount: number = 0;
  private consecutiveRestartCount: number = 0;
  private options: Required<PythonRunnerOptions>;
  private shutdownRequested: boolean = false;
  public readonly streamRegistry: StreamRegistry;
  private transport: JsonRpcTransport | null = null;
  private memoryMonitoringTimer: NodeJS.Timeout | null = null;
  private memoryCheckInProgress: boolean = false;
  private lastMemoryCheckStart: number = 0;
  private stderrHandler: ((chunk: Buffer) => void) | null = null;
  private startupTimeoutHandle: NodeJS.Timeout | null = null;

  constructor(options: PythonRunnerOptions = {}) {
    super();

    // Load configuration from YAML
    const config = getConfig();
    const projectRoot = this.findProjectRoot();

    // Set defaults from config
    this.options = {
      pythonPath: options.pythonPath || path.join(projectRoot, config.python_runtime.python_path),
      runtimePath: options.runtimePath || path.join(projectRoot, config.python_runtime.runtime_path),
      verbose: options.verbose ?? config.development.verbose,
      maxRestarts: options.maxRestarts ?? config.python_runtime.max_restarts,
      startupTimeout: options.startupTimeout ?? config.python_runtime.startup_timeout_ms,
      memoryThreshold: options.memoryThreshold ?? 512 * 1024 * 1024, // 512MB default
      memoryMonitoringInterval: options.memoryMonitoringInterval ?? 60000, // 1 minute default
      logger: options.logger!,
    };

    // Initialize stream registry with config values
    this.streamRegistry = new StreamRegistry({
      logger: this.options.logger,
      defaultTimeout: config.stream_registry.default_timeout_ms,
      maxActiveStreams: config.stream_registry.max_active_streams,
    });
  }

  /**
   * Get transport instance (for making JSON-RPC requests)
   */
  public getTransport(): JsonRpcTransport | null {
    return this.transport;
  }

  /**
   * Start the Python runtime process
   */
  public async start(): Promise<void> {
    // Check both process and status to prevent race conditions in concurrent calls
    // Allow restart from 'error' state by only blocking 'starting' and 'running'
    if (this.process !== null || this.status === 'starting') {
      throw new Error('Python runtime is already running or starting');
    }

    // Set status immediately to prevent concurrent start() calls
    this.status = 'starting';

    // Cleanup StreamRegistry from previous runs
    this.streamRegistry.cleanup();
    // BUG-014 FIX: Reinitialize timers after cleanup to restore functionality
    this.streamRegistry.reinitialize();

    this.startTime = Date.now();
    this.shutdownRequested = false;

    return new Promise((resolve, reject) => {
      let probeResponseHandler: ((data: Buffer) => void) | null = null;
      let probeTimeoutId: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        // Clean up probe response handler
        if (probeResponseHandler && this.process?.stdout) {
          this.process.stdout.off('data', probeResponseHandler);
          probeResponseHandler = null;
        }

        // Clean up probe timeout
        if (probeTimeoutId !== null) {
          clearTimeout(probeTimeoutId);
          probeTimeoutId = null;
        }
      };

      // Fix: Store timeout handle to allow cancellation on crash
      this.startupTimeoutHandle = setTimeout(() => {
        this.startupTimeoutHandle = null;
        cleanup();  // Clean up probe handler on timeout
        // PythonRunner Bug Fix: Kill orphaned process on startup timeout
        if (this.process) {
          this.process.kill('SIGTERM');
          this.process = null;
        }
        this.transport = null;
        this.status = 'stopped';  // Allow retry by returning to stopped state
        reject(new Error(`Python runtime failed to start within ${this.options.startupTimeout}ms`));
      }, this.options.startupTimeout);

      // Helper to complete startup (used by both probe and stderr fallback)
      const completeStartup = (runtimeInfo?: RuntimeInfoResponse): void => {
        // Cancel startup timeout to prevent killing restarted processes
        this.cancelStartupTimeout();

        if (this.transport || !this.process?.stdin || !this.process?.stdout) {
          cleanup(); // Ensure cleanup even if already completed
          return; // Already completed or process died
        }

        // Create transport
        this.transport = new JsonRpcTransport({
          stdin: this.process.stdin,
          stdout: this.process.stdout,
          stderr: this.process.stderr ?? undefined,
          logger: this.options.logger,
        });

        const handleTransportError = (error: Error): void => {
          this.options.logger?.error({ error }, 'JSON-RPC transport error');
          this.emit('error', error);

          if (this.shutdownRequested) {
            return;
          }

          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
          }
        };

        const handleTransportClose = (): void => {
          this.options.logger?.warn('JSON-RPC transport closed');

          if (this.shutdownRequested) {
            // Remove listeners to avoid leaks when stopping intentionally
            this.transport?.off('error', handleTransportError);
            this.transport?.off('close', handleTransportClose);
            return;
          }

          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
          }

          this.transport?.off('error', handleTransportError);
          this.transport?.off('close', handleTransportClose);
        };

        this.transport.on('error', handleTransportError);
        this.transport.on('close', handleTransportClose);

        // Setup notification routing
        this.transport.onNotification('stream.chunk', (params) => {
          // OPTIMIZATION #1: Use fast validation in production (highest frequency path)
          // This is called for EVERY token generated, so validation overhead is critical
          if (shouldUseFastValidation()) {
            // Fast path: Simple type guards (~1-2ms saved per token)
            try {
              const validated = fastValidateStreamChunk(params);
              this.streamRegistry.handleChunk(validated);
            } catch (error) {
              this.options.logger?.error(
                { params, error },
                'Invalid stream.chunk notification (fast check)'
              );
            }
            return;
          }

          // Development: Full Zod validation for safety
          const parseResult = StreamChunkNotificationSchema.safeParse({
            jsonrpc: '2.0',
            method: 'stream.chunk',
            params,
          });

          if (!parseResult.success) {
            this.options.logger?.error(
              { params, error: parseResult.error.format() },
              'Invalid stream.chunk notification'
            );
            return;
          }

          this.streamRegistry.handleChunk(parseResult.data.params);
        });

        this.transport.onNotification('stream.stats', (params) => {
          // OPTIMIZATION #1: Use fast validation in production
          // Called once per generation completion
          if (shouldUseFastValidation()) {
            try {
              const validated = fastValidateStreamStats(params);
              this.streamRegistry.handleStats(validated);
            } catch (error) {
              this.options.logger?.error(
                { params, error },
                'Invalid stream.stats notification (fast check)'
              );
            }
            return;
          }

          // Development: Full Zod validation
          const parseResult = StreamStatsNotificationSchema.safeParse({
            jsonrpc: '2.0',
            method: 'stream.stats',
            params,
          });

          if (!parseResult.success) {
            this.options.logger?.error(
              { params, error: parseResult.error.format() },
              'Invalid stream.stats notification'
            );
            return;
          }

          this.streamRegistry.handleStats(parseResult.data.params);
        });

        this.transport.onNotification('stream.event', (params) => {
          // OPTIMIZATION #1: Use fast validation in production
          // Called for stream lifecycle events
          if (shouldUseFastValidation()) {
            try {
              const validated = fastValidateStreamEvent(params);
              this.streamRegistry.handleEvent(validated);
            } catch (error) {
              this.options.logger?.error(
                { params, error },
                'Invalid stream.event notification (fast check)'
              );
            }
            return;
          }

          // Development: Full Zod validation
          const parseResult = StreamEventNotificationSchema.safeParse({
            jsonrpc: '2.0',
            method: 'stream.event',
            params,
          });

          if (!parseResult.success) {
            this.options.logger?.error(
              { params, error: parseResult.error.format() },
              'Invalid stream.event notification'
            );
            return;
          }

          this.streamRegistry.handleEvent(parseResult.data.params);
        });

        // Fix Bug #17: Clear startup timeout handle (already done at line 201, keeping for safety)
        this.cancelStartupTimeout();
        cleanup(); // Clean up all probe resources
        this.status = 'ready';
        this.options.logger?.info({ runtimeInfo }, 'Python runtime is ready');

        // Start memory monitoring
        this.startMemoryMonitoring();

        this.emit('ready');
        resolve();
      };

      try {
        // Spawn Python process
        this.process = spawn(this.options.pythonPath, [this.options.runtimePath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1', // Disable Python output buffering
          },
        });

        this.options.logger?.info({ pid: this.process.pid }, 'Python runtime process spawned');

        // Note: stdout handler setup is deferred until after readiness probe
        // to avoid handler conflicts. JsonRpcTransport will handle all stdout.

        // Handle stderr (logs and errors) - use completeStartup fallback
        // Remove old handler if exists to prevent listener leak
        if (this.stderrHandler && this.process.stderr) {
          this.process.stderr.off('data', this.stderrHandler);
        }

        // Flag to track if probe has been sent (prevent duplicate probes)
        let probeSent = false;

        // Helper function to send readiness probe
        const sendReadinessProbe = async (): Promise<void> => {
          if (probeSent) {
            return; // Prevent duplicate probe requests
          }
          probeSent = true;

          try {
            // Send runtime/info probe via stdin
            const probeRequest = JSON.stringify({
              jsonrpc: '2.0',
              method: 'runtime/info',
              id: 'readiness-probe',
            });

            this.process?.stdin?.write(probeRequest + '\n');
            this.options.logger?.debug('Readiness probe sent');

            // Buffer stdout until full JSON lines arrive
            let probeBuffer = '';
            probeResponseHandler = (data: Buffer) => {
              probeBuffer += data.toString('utf-8');
              let idx: number;

              // Process all complete lines in buffer
              while ((idx = probeBuffer.indexOf('\n')) !== -1) {
                const frame = probeBuffer.slice(0, idx).trim();
                probeBuffer = probeBuffer.slice(idx + 1);

                if (!frame) continue;

                try {
                  const response = JSON.parse(frame);
                  if (response.id === 'readiness-probe' && response.result) {
                    // OPTIMIZATION #2: Skip full Zod validation in production for performance
                    // Development: Full validation for safety
                    // Production: Trust Python runtime output, use fast type assertions
                    let runtimeInfo: RuntimeInfoResponse | undefined;

                    if (process.env.NODE_ENV === 'production') {
                      // Fast path: Basic runtime check, skip Zod overhead (~15-25ms saved)
                      const result = response.result;
                      if (result && typeof result === 'object' && 'version' in result && 'capabilities' in result) {
                        runtimeInfo = result as RuntimeInfoResponse;
                      } else {
                        this.options.logger?.warn({ result }, 'Invalid runtime/info response (fast check)');
                      }
                    } else {
                      // Development: Full Zod validation for safety
                      const runtimeInfoResult = RuntimeInfoResponseSchema.safeParse(response.result);

                      if (!runtimeInfoResult.success) {
                        this.options.logger?.warn(
                          {
                            error: runtimeInfoResult.error.format(),
                            result: response.result,
                          },
                          'Invalid runtime/info response payload'
                        );
                      }

                      runtimeInfo = runtimeInfoResult.success ? runtimeInfoResult.data : undefined;
                    }

                    completeStartup(runtimeInfo);
                    return;
                  }
                } catch (err) {
                  this.options.logger?.debug({ err, frame }, 'Failed to parse probe frame');
                }
              }
            };

            this.process?.stdout?.on('data', probeResponseHandler);
          } catch (err) {
            this.options.logger?.warn({ err }, 'Failed to probe runtime/info');
          }
        };

        this.stderrHandler = (chunk: Buffer) => {
          const text = chunk.toString();
          this.emit('stderr', text.trim());
          this.options.logger?.warn({ error: text.trim() }, 'Python stderr');

          // EVENT-DRIVEN READINESS: Send probe immediately when Python signals ready
          // This eliminates the 500ms fixed delay, reducing startup time by ~400ms
          if (text.includes('MLX Runtime ready')) {
            this.options.logger?.debug('Python runtime ready signal received, sending probe');
            sendReadinessProbe().catch((err) => {
              this.options.logger?.warn({ err }, 'Failed to send readiness probe on ready signal');
            });
          }
        };

        this.process.stderr?.on('data', this.stderrHandler);

        // FALLBACK: If Python doesn't emit ready signal, probe after timeout
        // Increased from 500ms to 3000ms as this is now a safety fallback only
        const config = getConfig();
        const fallbackDelayMs = config.python_runtime.init_probe_fallback_ms ?? 3000;
        probeTimeoutId = setTimeout(() => {
          if (!probeSent) {
            this.options.logger?.warn(
              { fallbackDelayMs },
              'Python ready signal not received, using fallback probe'
            );
            sendReadinessProbe().catch((err) => {
              this.options.logger?.warn({ err }, 'Failed to send fallback readiness probe');
            });
          }
        }, fallbackDelayMs);

        // Handle process exit
        this.process.on('exit', (code, signal) => {
          this.options.logger?.info({ code, signal }, 'Python process exited');

          // Cleanup probe handler and timeout if still attached
          cleanup();

          // If process exits during startup (before readiness), reject the Promise
          // to prevent start() from hanging forever
          const wasStarting = this.status === 'starting';

          // Cleanup transport
          if (this.transport) {
            this.transport.close().catch(() => {});
            this.transport = null;
          }

          // Cleanup stream registry on unexpected exit
          if (!this.shutdownRequested) {
            this.streamRegistry.cleanup();
          }

          this.process = null;
          this.status = 'stopped';
          this.emit('exit', code);

          // Reject startup promise if process exited during startup
          if (wasStarting) {
            this.cancelStartupTimeout();
            reject(
              new Error(
                `Python process exited during startup with code ${code}${
                  signal ? ` (signal: ${signal})` : ''
                }`
              )
            );
          } else if (!this.shutdownRequested) {
            this.handleCrash(code);
          }
        });

        // Handle process errors
        this.process.on('error', (err) => {
          cleanup();  // Clean up probe handler on error
          this.cancelStartupTimeout();  // Fix: Use correct instance method
          // PythonRunner Bug Fix: Clean up process reference on error
          if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
          }
          this.transport = null;
          this.status = 'stopped';  // Allow retry by returning to stopped state
          this.options.logger?.error({ err }, 'Python process error');
          this.emit('error', err);
          reject(err);
        });
      } catch (err) {
        this.cancelStartupTimeout();  // Fix: Use correct instance method
        // Set status to 'stopped' instead of 'error' to allow restart
        // This prevents the engine from being permanently bricked after a transient failure
        this.status = 'stopped';
        reject(err);
      }
    });
  }

  /**
   * Stop the Python runtime process
   */
  public async stop(): Promise<void> {
    // Set shutdown flag FIRST to prevent race conditions
    this.shutdownRequested = true;

    // Stop memory monitoring
    this.stopMemoryMonitoring();

    if (this.process === null) {
      return;
    }

    this.options.logger?.info('Stopping Python runtime...');

    // Send graceful shutdown signal
    this.process.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'shutdown',
        id: 'shutdown',
      }) + '\n'
    );

    // Wait for graceful shutdown
    const config = getConfig();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if not stopped gracefully
        if (this.process) {
          this.options.logger?.warn('Force killing Python process');
          this.process.kill('SIGKILL');
        }
        resolve();
      }, config.python_runtime.shutdown_timeout_ms);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.process = null;
    this.status = 'stopped';

    // Cleanup stream registry
    this.streamRegistry.cleanup();
  }

  /**
   * Send data to Python process stdin
   */
  public write(data: string): void {
    if (this.process === null || this.status !== 'ready') {
      throw new Error('Python runtime is not ready');
    }

    if (this.options.verbose) {
      this.options.logger?.debug({ data }, 'Writing to Python stdin');
    }

    this.process.stdin?.write(data + '\n');
  }

  /**
   * Get runtime information
   */
  public getInfo(): RuntimeInfo {
    // Only calculate uptime if process has been started (startTime > 0)
    const uptime = this.status === 'stopped' || this.startTime === 0
      ? 0
      : Date.now() - this.startTime;

    // Get current memory usage
    const memoryUsage = this.process ? process.memoryUsage().heapUsed : 0;

    return {
      pid: this.process?.pid ?? -1,
      uptime,
      memoryUsage,
      status: this.status,
    };
  }

  /**
   * Check if runtime is ready
   */
  public isReady(): boolean {
    return this.status === 'ready' && this.process !== null;
  }

  /**
   * Get stdin stream (for JsonRpcTransport)
   */
  public getStdin(): Writable | null {
    return this.process?.stdin ?? null;
  }

  /**
   * Get stdout stream (for JsonRpcTransport)
   */
  public getStdout(): Readable | null {
    return this.process?.stdout ?? null;
  }

  /**
   * Get stderr stream (for JsonRpcTransport)
   */
  public getStderr(): Readable | null {
    return this.process?.stderr ?? null;
  }

  /**
   * Handle unexpected process crash
   */
  private async handleCrash(exitCode: number | null): Promise<void> {
    // Fix: Cancel any pending startup timeout to prevent killing the restarted process
    this.cancelStartupTimeout();

    if (this.shutdownRequested) {
      return;
    }

    this.restartCount += 1;
    this.consecutiveRestartCount += 1;
    this.options.logger?.warn(
      {
        exitCode,
        restartCount: this.restartCount,
        consecutiveRestartCount: this.consecutiveRestartCount,
        maxRestarts: this.options.maxRestarts,
      },
      'Python process crashed'
    );

    // Fix: Use > instead of >= to allow maxRestarts attempts (not maxRestarts-1)
    if (this.restartCount > this.options.maxRestarts) {
      const error = new Error(
        `Python runtime crashed ${this.restartCount} times, exceeded max restarts`
      );
      this.emit('error', error);
      return;
    }

    // Restart after brief delay with exponential backoff
    const config = getConfig();
    const attemptNumber = this.consecutiveRestartCount;
    this.emit('restart', attemptNumber);
    const backoffDelay = config.python_runtime.restart_delay_base_ms * attemptNumber;
    await new Promise((resolve) => setTimeout(resolve, backoffDelay));

    // Fix: Re-check shutdownRequested after backoff delay
    if (this.shutdownRequested) {
      this.options.logger?.info('Shutdown requested during restart backoff, aborting restart');
      return;
    }

    try {
      await this.start();
      // Bug #4 P1: Only reset consecutive counter so lifetime restarts keep accruing.
      this.consecutiveRestartCount = 0;
      this.options.logger?.info('Python runtime restarted successfully');
    } catch (err) {
      this.options.logger?.error({ err }, 'Failed to restart Python runtime');
      this.emit('error', err as Error);
    }
  }

  /**
   * Cancel pending startup timeout
   * Safe to call multiple times or when already cancelled
   */
  private cancelStartupTimeout(): void {
    if (this.startupTimeoutHandle !== null) {
      clearTimeout(this.startupTimeoutHandle);
      this.startupTimeoutHandle = null;
    }
  }

  /**
   * Start periodic memory monitoring
   * Fix Bug #30 (Medium): Monitor Python child process, not Node.js parent process
   */
  private startMemoryMonitoring(): void {
    // Stop any existing monitoring first
    this.stopMemoryMonitoring();

    // Only start if interval > 0
    if (this.options.memoryMonitoringInterval <= 0) {
      return;
    }

    this.memoryMonitoringTimer = setInterval(async () => {
      // Bug Fix #6: Prevent concurrent memory checks from stacking up
      // Bug Fix #44: Add timeout protection to prevent permanent deadlock
      // If previous check is still running, check if it's stuck
      if (this.memoryCheckInProgress) {
        const timeSinceLastCheck = Date.now() - this.lastMemoryCheckStart;
        const maxCheckDuration = this.options.memoryMonitoringInterval * 2;

        if (timeSinceLastCheck > maxCheckDuration) {
          // Previous check is stuck for too long - force reset
          this.options.logger?.warn(
            {
              timeSinceLastCheck,
              maxCheckDuration,
              memoryMonitoringInterval: this.options.memoryMonitoringInterval,
            },
            'Memory check stuck, forcing reset to prevent permanent deadlock'
          );
          this.memoryCheckInProgress = false;
          this.lastMemoryCheckStart = 0;
        } else {
          // Previous check still in progress but not stuck yet
          this.options.logger?.debug(
            { timeSinceLastCheck },
            'Skipping memory check: previous check still in progress'
          );
          return;
        }
      }

      if (!this.process || this.status !== 'ready' || !this.transport) {
        return;
      }

      this.memoryCheckInProgress = true;
      this.lastMemoryCheckStart = Date.now();

      try {
        // Get Python process memory from runtime/info
        // Bug Fix #44: Add explicit 10-second timeout to prevent deadlock
        // Memory checks should be fast - if Python is unresponsive, fail fast
        const response = await this.transport.request<RuntimeInfoResponse>(
          'runtime/info',
          undefined,
          { timeout: 10000 }
        );

        if (response.memory && response.memory.rss > this.options.memoryThreshold) {
          const warning: MemoryWarning = {
            heapUsed: response.memory.rss,
            heapTotal: response.memory.vms,
            rss: response.memory.rss,
            external: 0,
            threshold: this.options.memoryThreshold,
          };

          this.options.logger?.warn(
            {
              rss: `${(response.memory.rss / 1024 / 1024).toFixed(2)}MB`,
              threshold: `${(this.options.memoryThreshold / 1024 / 1024).toFixed(2)}MB`,
            },
            'High Python memory usage detected'
          );

          this.emit('memory-warning', warning);
        }
      } catch (err) {
        // Silently fail if runtime/info is unavailable
        // This can happen if Python is busy or unresponsive
        this.options.logger?.debug({ err }, 'Failed to get Python memory usage');
      } finally {
        // Always reset flag and timestamp, even on error
        this.memoryCheckInProgress = false;
        this.lastMemoryCheckStart = 0;
      }
    }, this.options.memoryMonitoringInterval);

    this.options.logger?.debug(
      {
        interval: this.options.memoryMonitoringInterval,
        threshold: `${(this.options.memoryThreshold / 1024 / 1024).toFixed(2)}MB`,
      },
      'Memory monitoring started'
    );
  }

  /**
   * Stop periodic memory monitoring
   */
  private stopMemoryMonitoring(): void {
    if (this.memoryMonitoringTimer) {
      clearInterval(this.memoryMonitoringTimer);
      this.memoryMonitoringTimer = null;
      this.options.logger?.debug('Memory monitoring stopped');
    }
  }

  /**
   * Find project root directory
   */
  private findProjectRoot(): string {
    // Look for package.json or python/ directory
    let currentDir = __dirname;
    const maxDepth = 10;
    let depth = 0;

    while (depth < maxDepth) {
      try {
        const packageJsonPath = path.join(currentDir, 'package.json');
        const pythonDir = path.join(currentDir, 'python');

        if (existsSync(packageJsonPath) || existsSync(pythonDir)) {
          return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          break; // Reached root
        }
        currentDir = parentDir;
        depth++;
      } catch {
        break;
      }
    }

    // Fallback to cwd
    return process.cwd();
  }
}
