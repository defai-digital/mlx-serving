/**
 * API Helper utilities for kr-serve-mlx
 *
 * Provides convenience functions for common operations with the Engine API.
 */

import type {
  Engine,
  GeneratorParams,
  GeneratorChunk,
  LoadModelOptions,
  ModelHandle,
  EngineOptions,
} from '../types/index.js';
import { createEngine } from './engine.js';

/**
 * Simple generate function that collects all tokens into a single string.
 *
 * @param engine - The engine instance
 * @param params - Generator parameters
 * @returns The complete generated text
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * await engine.loadModel({ model: 'llama-3.1-8b' });
 * const text = await generateText(engine, {
 *   model: 'llama-3.1-8b',
 *   prompt: 'Hello, world!',
 *   maxTokens: 100,
 * });
 * console.log(text);
 * ```
 */
export async function generateText(
  engine: Engine,
  params: GeneratorParams
): Promise<string> {
  const tokens: string[] = [];

  for await (const chunk of engine.createGenerator(params)) {
    if (chunk.type === 'token') {
      tokens.push(chunk.token);
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error.message);
    }
  }

  return tokens.join('');
}

/**
 * Generate text with streaming callback for real-time token processing.
 *
 * @param engine - The engine instance
 * @param params - Generator parameters
 * @param onToken - Callback invoked for each generated token
 * @returns The complete generated text
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * await engine.loadModel({ model: 'llama-3.1-8b' });
 * const text = await generateTextStreaming(
 *   engine,
 *   { model: 'llama-3.1-8b', prompt: 'Hello!' },
 *   (token) => process.stdout.write(token)
 * );
 * ```
 */
export async function generateTextStreaming(
  engine: Engine,
  params: GeneratorParams,
  onToken: (token: string) => void
): Promise<string> {
  const tokens: string[] = [];

  for await (const chunk of engine.createGenerator(params)) {
    if (chunk.type === 'token') {
      tokens.push(chunk.token);
      onToken(chunk.token);
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error.message);
    }
  }

  return tokens.join('');
}

/**
 * Load a model if not already loaded.
 *
 * @param engine - The engine instance
 * @param options - Load model options
 * @returns The model handle (existing or newly loaded)
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * const handle = await ensureModelLoaded(engine, {
 *   model: 'llama-3.1-8b',
 * });
 * ```
 */
export async function ensureModelLoaded(
  engine: Engine,
  options: LoadModelOptions
): Promise<ModelHandle> {
  const modelId = typeof options.model === 'string'
    ? options.model
    : options.model.id;

  const existing = engine.getModelInfo(modelId);
  if (existing && existing.state === 'ready') {
    return existing;
  }

  return engine.loadModel(options);
}

/**
 * Batch tokenize multiple texts efficiently.
 *
 * @param engine - The engine instance
 * @param model - The model identifier
 * @param texts - Array of texts to tokenize
 * @returns Array of token arrays
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * await engine.loadModel({ model: 'llama-3.1-8b' });
 * const tokenArrays = await batchTokenize(engine, 'llama-3.1-8b', [
 *   'First text',
 *   'Second text',
 *   'Third text',
 * ]);
 * ```
 */
export async function batchTokenize(
  engine: Engine,
  model: string,
  texts: string[]
): Promise<number[][]> {
  const results = await Promise.all(
    texts.map(text =>
      engine.tokenize({ model, text })
    )
  );

  return results.map(r => r.tokens);
}

/**
 * Collect all chunks from a generator into an array.
 *
 * @param engine - The engine instance
 * @param params - Generator parameters
 * @returns Array of all generator chunks
 *
 * @example
 * ```typescript
 * const chunks = await collectChunks(engine, {
 *   model: 'llama-3.1-8b',
 *   prompt: 'Hello!',
 * });
 * const tokens = chunks.filter(c => c.type === 'token');
 * const stats = chunks.find(c => c.type === 'metadata');
 * ```
 */
export async function collectChunks(
  engine: Engine,
  params: GeneratorParams
): Promise<GeneratorChunk[]> {
  const chunks: GeneratorChunk[] = [];

  for await (const chunk of engine.createGenerator(params)) {
    chunks.push(chunk);
    if (chunk.type === 'error') {
      throw new Error(chunk.error.message);
    }
  }

  return chunks;
}

/**
 * Wait for a model to reach 'ready' state with timeout.
 *
 * @param engine - The engine instance
 * @param modelId - The model identifier
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 30000)
 * @param pollIntervalMs - Polling interval in milliseconds (default: 100)
 * @returns The ready model handle
 * @throws Error if timeout is reached or model fails
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * void engine.loadModel({ model: 'llama-3.1-8b' });
 * const handle = await waitForModelReady(engine, 'llama-3.1-8b', 30000);
 * ```
 */
export async function waitForModelReady(
  engine: Engine,
  modelId: string,
  timeoutMs = 30000,
  pollIntervalMs = 100
): Promise<ModelHandle> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const handle = engine.getModelInfo(modelId);

    if (!handle) {
      throw new Error(`Model ${modelId} not found`);
    }

    if (handle.state === 'ready') {
      return handle;
    }

    if (handle.state === 'failed') {
      throw new Error(`Model ${modelId} failed to load`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timeout waiting for model ${modelId} to be ready`);
}

/**
 * Check if engine is healthy and ready for inference.
 *
 * @param engine - The engine instance
 * @returns true if healthy, false otherwise
 *
 * @example
 * ```typescript
 * const engine = await createEngine();
 * if (await isEngineHealthy(engine)) {
 *   // Proceed with inference
 * }
 * ```
 */
export async function isEngineHealthy(engine: Engine): Promise<boolean> {
  try {
    const health = await engine.healthCheck();
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Get total token count across multiple texts.
 *
 * @param engine - The engine instance
 * @param model - The model identifier
 * @param texts - Array of texts
 * @returns Total token count
 *
 * @example
 * ```typescript
 * const count = await getTotalTokenCount(engine, 'llama-3.1-8b', [
 *   'First text',
 *   'Second text',
 * ]);
 * console.log(`Total tokens: ${count}`);
 * ```
 */
export async function getTotalTokenCount(
  engine: Engine,
  model: string,
  texts: string[]
): Promise<number> {
  const tokenArrays = await batchTokenize(engine, model, texts);
  return tokenArrays.reduce((sum, tokens) => sum + tokens.length, 0);
}

/**
 * Retry a model load operation with exponential backoff.
 *
 * @param engine - The engine instance
 * @param options - Load model options
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param initialDelayMs - Initial delay in milliseconds (default: 1000)
 * @returns The loaded model handle
 *
 * @example
 * ```typescript
 * const handle = await retryLoadModel(engine, {
 *   model: 'llama-3.1-8b',
 * }, 3, 1000);
 * ```
 */
export async function retryLoadModel(
  engine: Engine,
  options: LoadModelOptions,
  maxRetries = 3,
  initialDelayMs = 1000
): Promise<ModelHandle> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await engine.loadModel(options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Failed to load model after retries');
}

/**
 * Context manager-style wrapper for automatic engine cleanup.
 *
 * Provides Python-style context manager behavior for TypeScript/JavaScript.
 * Automatically creates, manages, and disposes of an engine instance,
 * ensuring proper resource cleanup even if errors occur.
 *
 * This is the TypeScript equivalent of Python's `with MLXEngine() as engine:` pattern.
 *
 * @param callback - Async function that receives the engine instance
 * @param options - Optional engine creation options
 * @returns The return value of the callback function
 * @throws Re-throws any error from the callback after cleanup
 *
 * @example
 * ```typescript
 * // Basic usage (similar to Python's `with` statement)
 * const result = await withEngine(async (engine) => {
 *   await engine.loadModel({ model: 'llama-3-8b-instruct' });
 *   return await engine.generate({
 *     model: 'llama-3-8b-instruct',
 *     prompt: 'Hello, world!',
 *     maxTokens: 100,
 *   });
 * });
 * // Engine automatically disposed here
 * console.log(result);
 * ```
 *
 * @example
 * ```typescript
 * // With custom engine options
 * const tokens = await withEngine(
 *   async (engine) => {
 *     await engine.loadModel({ model: 'llama-3-8b-instruct' });
 *     const response = await engine.tokenize({
 *       model: 'llama-3-8b-instruct',
 *       text: 'Hello, world!',
 *     });
 *     return response.tokens;
 *   },
 *   { pythonPath: '/custom/python', cacheDir: '/custom/cache' }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Error handling (engine still disposed even if error occurs)
 * try {
 *   await withEngine(async (engine) => {
 *     await engine.loadModel({ model: 'invalid-model' });
 *     return await engine.generate({ model: 'invalid-model', prompt: 'Hi' });
 *   });
 * } catch (error) {
 *   console.error('Generation failed:', error);
 *   // Engine was properly disposed despite the error
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Streaming generation with automatic cleanup
 * await withEngine(async (engine) => {
 *   await engine.loadModel({ model: 'llama-3-8b-instruct' });
 *
 *   for await (const chunk of engine.createGenerator({
 *     model: 'llama-3-8b-instruct',
 *     prompt: 'Tell me a story',
 *     maxTokens: 200,
 *   })) {
 *     if (chunk.type === 'token') {
 *       process.stdout.write(chunk.token);
 *     }
 *   }
 * });
 * // Engine automatically cleaned up after streaming completes
 * ```
 */
export async function withEngine<T>(
  callback: (engine: Engine) => Promise<T>,
  options?: EngineOptions
): Promise<T> {
  const engine = await createEngine(options);

  try {
    // Execute user callback with the engine instance
    return await callback(engine);
  } finally {
    // Always cleanup, even if callback throws
    // This mimics Python's __exit__ method in context managers
    await engine.dispose();
  }
}
