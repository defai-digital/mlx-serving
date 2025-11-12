/**
 * MLXEngine - Simplified convenience wrapper (mlx-engine compatible)
 *
 * Provides a simplified API that matches mlx-engine's MLXEngine class.
 * Automatically handles Engine initialization and model loading in the constructor.
 *
 * @example Python mlx-engine style
 * ```python
 * from mlx_engine import MLXEngine
 * engine = MLXEngine("llama-3.1-8b")
 * text = engine.generate("Hello, world!", max_tokens=100)
 * ```
 *
 * @example TypeScript mlx-serving equivalent
 * ```typescript
 * import { MLXEngine } from '@defai.digital/mlx-serving';
 * const engine = new MLXEngine("llama-3.1-8b");
 * await engine.init(); // Required in TypeScript (can't be async in constructor)
 * const text = await engine.generate("Hello, world!", { max_tokens: 100 });
 * ```
 */

import { createEngine } from './engine.js';
import type {
  Engine,
  ModelHandle,
  LoadModelOptions,
  GeneratorParams,
  GeneratorChunk,
} from '../types/index.js';

/**
 * Simplified MLXEngine class for quick prototyping and benchmarking.
 *
 * This class provides a streamlined API matching mlx-engine's MLXEngine,
 * hiding the complexity of Engine lifecycle management and model loading.
 *
 * @example Basic usage
 * ```typescript
 * const engine = new MLXEngine("llama-3.1-8b");
 * await engine.init();
 *
 * // Simple generate
 * const text = await engine.generate("Hello!", { max_tokens: 50 });
 *
 * // Streaming generate
 * for await (const chunk of engine.generateStream("Hello!", { max_tokens: 50 })) {
 *   process.stdout.write(chunk.token);
 * }
 *
 * // Cleanup
 * await engine.dispose();
 * ```
 *
 * @example With options
 * ```typescript
 * const engine = new MLXEngine({
 *   model: "llama-3.1-8b",
 *   quantization: "4bit",
 *   revision: "main"
 * });
 * await engine.init();
 * ```
 */
export class MLXEngine {
  private engine: Engine | null = null;
  private modelHandle: ModelHandle | null = null;
  private readonly modelOptions: LoadModelOptions | string;
  private initialized = false;

  /**
   * Create a new MLXEngine instance.
   *
   * Note: You must call init() after construction to load the model.
   *
   * @param modelPath - Model identifier string or load options
   *
   * @example
   * ```typescript
   * // Positional string (matches mlx-engine Python API)
   * const engine = new MLXEngine("llama-3.1-8b");
   *
   * // With full options
   * const engine = new MLXEngine({
   *   model: "llama-3.1-8b",
   *   quantization: "4bit"
   * });
   * ```
   */
  constructor(modelPath: string | LoadModelOptions) {
    this.modelOptions = modelPath;
  }

  /**
   * Initialize the engine and load the model.
   *
   * Must be called before using generate() or other methods.
   * Separated from constructor because async operations can't be in constructors.
   *
   * @returns This instance for chaining
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   * // Now ready to use
   * ```
   */
  async init(): Promise<this> {
    if (this.initialized) {
      return this;
    }

    this.engine = await createEngine();
    this.modelHandle = await this.engine.loadModel(this.modelOptions);
    this.initialized = true;

    return this;
  }

  /**
   * Ensure engine is initialized, throwing if not.
   * @internal
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.engine || !this.modelHandle) {
      throw new Error('MLXEngine not initialized. Call init() first.');
    }
  }

  /**
   * Generate text from a prompt (non-streaming).
   *
   * Collects all tokens and returns the complete generated text.
   * Matches mlx-engine's MLXEngine.generate() behavior.
   *
   * @param prompt - Text prompt
   * @param params - Generation parameters (max_tokens, temperature, etc.)
   * @returns Complete generated text
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   *
   * const text = await engine.generate("What is AI?", {
   *   max_tokens: 100,
   *   temperature: 0.7
   * });
   * console.log(text);
   * ```
   */
  async generate(
    prompt: string,
    params?: Omit<Partial<GeneratorParams>, 'model' | 'prompt'>
  ): Promise<string> {
    this.ensureInitialized();

    const tokens: string[] = [];

    for await (const chunk of this.generateStream(prompt, params)) {
      if (chunk.type === 'token') {
        tokens.push(chunk.token);
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error.message);
      }
    }

    return tokens.join('');
  }

  /**
   * Generate text with streaming (async generator).
   *
   * Yields token chunks as they are generated, allowing real-time processing.
   *
   * @param prompt - Text prompt
   * @param params - Generation parameters
   * @returns Async generator yielding chunks
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   *
   * for await (const chunk of engine.generateStream("Hello!", { max_tokens: 50 })) {
   *   if (chunk.type === 'token') {
   *     process.stdout.write(chunk.token);
   *   }
   * }
   * ```
   */
  async *generateStream(
    prompt: string,
    params?: Omit<Partial<GeneratorParams>, 'model' | 'prompt'>
  ): AsyncGenerator<GeneratorChunk, void, unknown> {
    this.ensureInitialized();

    const generatorParams: GeneratorParams = {
      model: this.modelHandle!.descriptor.id,
      prompt,
      streaming: true,
      ...params,
    };

    for await (const chunk of this.engine!.createGenerator(generatorParams)) {
      yield chunk;
    }
  }

  /**
   * Tokenize text using the loaded model.
   *
   * @param text - Text to tokenize
   * @returns Token array
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   *
   * const tokens = await engine.tokenize("Hello, world!");
   * console.log(tokens);  // [123, 456, 789]
   * ```
   */
  async tokenize(text: string): Promise<number[]> {
    this.ensureInitialized();

    const result = await this.engine!.tokenize({
      model: this.modelHandle!.descriptor.id,
      text,
    });

    return result.tokens;
  }

  /**
   * Get the model handle (for advanced usage).
   *
   * @returns The loaded model handle
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   *
   * const handle = engine.getModelHandle();
   * console.log(handle.descriptor.id);
   * ```
   */
  getModelHandle(): ModelHandle | null {
    return this.modelHandle;
  }

  /**
   * Get the underlying Engine instance (for advanced usage).
   *
   * @returns The Engine instance
   *
   * @example
   * ```typescript
   * const mlxEngine = new MLXEngine("llama-3.1-8b");
   * await mlxEngine.init();
   *
   * const engine = mlxEngine.getEngine();
   * const info = await engine.getRuntimeInfo();
   * ```
   */
  getEngine(): Engine | null {
    return this.engine;
  }

  /**
   * Check if the engine is initialized and ready to use.
   *
   * @returns true if initialized, false otherwise
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose of the engine and unload the model.
   *
   * Should be called when done to free resources.
   *
   * @example
   * ```typescript
   * const engine = new MLXEngine("llama-3.1-8b");
   * await engine.init();
   * // ... use engine ...
   * await engine.dispose();
   * ```
   */
  async dispose(): Promise<void> {
    if (this.engine) {
      if (this.modelHandle) {
        await this.engine.unloadModel(this.modelHandle.descriptor.id);
        this.modelHandle = null;
      }
      await this.engine.shutdown();
      this.engine = null;
    }
    this.initialized = false;
  }
}

/**
 * Convenience function to create and initialize an MLXEngine in one step.
 *
 * @param modelPath - Model identifier or options
 * @returns Initialized MLXEngine instance
 *
 * @example
 * ```typescript
 * // One-liner initialization
 * const engine = await createMLXEngine("llama-3.1-8b");
 * const text = await engine.generate("Hello!", { max_tokens: 50 });
 * ```
 */
export async function createMLXEngine(
  modelPath: string | LoadModelOptions
): Promise<MLXEngine> {
  const engine = new MLXEngine(modelPath);
  await engine.init();
  return engine;
}
