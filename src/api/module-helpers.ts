/**
 * mlx-engine compatible module-level helper functions
 *
 * These functions provide a script-friendly API that matches mlx-engine's
 * module-level interface, using a lazy-initialized global Engine instance.
 *
 * @example Python mlx-engine style
 * ```python
 * import mlx_engine.generate as generate
 * model_kit = generate.load_model("llama")
 * tokens = generate.tokenize(model_kit, "Hello")
 * for chunk in generate.create_generator(model_kit, tokens, max_tokens=100):
 *     print(chunk['token'])
 * ```
 *
 * @example TypeScript mlx-serving equivalent
 * ```typescript
 * import { load_model, tokenize, create_generator } from '@defai.digital/mlx-serving/module-helpers';
 * const model_kit = await load_model("llama");
 * const result = await tokenize(model_kit, "Hello");
 * for await (const chunk of create_generator(model_kit, result.tokens, { max_tokens: 100 })) {
 *     console.log(chunk.token);
 * }
 * ```
 */

import { createEngine } from '../index.js';
import type {
  Engine,
  ModelHandle,
  LoadModelOptions,
  GeneratorParams,
  GeneratorChunk,
  TokenizeResponse,
} from '../types/index.js';

/**
 * Lazy-initialized global Engine instance for module-level functions.
 * This matches mlx-engine's global state approach.
 */
let globalEngine: Engine | null = null;

/**
 * Get or create the global Engine instance.
 * @internal
 */
async function getGlobalEngine(): Promise<Engine> {
  if (!globalEngine) {
    globalEngine = await createEngine();
  }
  return globalEngine;
}

/**
 * Load a model using module-level function (mlx-engine style).
 *
 * Supports both positional string and options object:
 * - `load_model("llama")`
 * - `load_model({ model: "llama", quantization: "4bit" })`
 *
 * @param model - Model identifier string or load options
 * @param options - Additional options when using string parameter
 * @returns Model handle (model_kit) for use with other module functions
 *
 * @example
 * ```typescript
 * // Positional string (matches Python: load_model("llama"))
 * const model_kit = await load_model("llama-3.1-8b");
 *
 * // With options
 * const model_kit = await load_model("llama-3.1-8b", {
 *   quantization: "4bit",
 *   revision: "main"
 * });
 *
 * // Object style
 * const model_kit = await load_model({
 *   model: "llama-3.1-8b",
 *   quantization: "4bit"
 * });
 * ```
 */
export async function load_model(
  model: string | LoadModelOptions,
  options?: Partial<Omit<LoadModelOptions, 'model'>>
): Promise<ModelHandle> {
  const engine = await getGlobalEngine();

  // Support both positional and object styles
  const loadOptions: LoadModelOptions | string = typeof model === 'string'
    ? (options ? { model, ...options } as LoadModelOptions : model)
    : model;

  return engine.loadModel(loadOptions);
}

/**
 * Create a generator for text generation (mlx-engine style).
 *
 * @param model_kit - Model handle returned from load_model()
 * @param prompt - Text prompt or token array
 * @param params - Generation parameters (max_tokens, temperature, etc.)
 * @returns Async generator yielding token chunks
 *
 * @example
 * ```typescript
 * const model_kit = await load_model("llama-3.1-8b");
 * const tokenResult = await tokenize(model_kit, "Hello, world!");
 *
 * // Using tokens (matches Python API)
 * for await (const chunk of create_generator(
 *   model_kit,
 *   tokenResult.tokens,
 *   { max_tokens: 100, temperature: 0.7 }
 * )) {
 *   if (chunk.type === 'token') {
 *     console.log(chunk.token);
 *   }
 * }
 *
 * // Using text prompt (also supported)
 * for await (const chunk of create_generator(
 *   model_kit,
 *   "Hello, world!",
 *   { max_tokens: 100 }
 * )) {
 *   console.log(chunk.token);
 * }
 * ```
 */
export async function* create_generator(
  model_kit: ModelHandle,
  prompt: string | number[],
  params?: Omit<Partial<GeneratorParams>, 'model' | 'prompt'>
): AsyncGenerator<GeneratorChunk, void, unknown> {
  const engine = await getGlobalEngine();

  const generatorParams: GeneratorParams = {
    model: model_kit.descriptor.id,
    prompt: typeof prompt === 'string' ? prompt : { tokens: prompt },
    ...params,
  };

  for await (const chunk of engine.createGenerator(generatorParams)) {
    yield chunk;
  }
}

/**
 * Tokenize text using a loaded model (mlx-engine style).
 *
 * @param model_kit - Model handle returned from load_model()
 * @param text - Text to tokenize
 * @param options - Tokenization options
 * @returns Token array and optionally token strings
 *
 * @example
 * ```typescript
 * const model_kit = await load_model("llama-3.1-8b");
 * const result = await tokenize(model_kit, "Hello, world!");
 * console.log(result.tokens);  // [123, 456, 789]
 * ```
 */
export async function tokenize(
  model_kit: ModelHandle,
  text: string,
  options?: { add_bos?: boolean }
): Promise<TokenizeResponse> {
  const engine = await getGlobalEngine();

  return engine.tokenize({
    model: model_kit.descriptor.id,
    text,
    ...options,
  });
}

/**
 * Simple synchronous-style generate function (mlx-engine convenience).
 *
 * Collects all tokens and returns complete text, matching mlx-engine's
 * non-streaming generate behavior.
 *
 * @param model_kit - Model handle
 * @param prompt - Text prompt or tokens
 * @param params - Generation parameters
 * @returns Complete generated text
 *
 * @example
 * ```typescript
 * const model_kit = await load_model("llama-3.1-8b");
 * const text = await generate(model_kit, "Hello!", { max_tokens: 50 });
 * console.log(text);
 * ```
 */
export async function generate(
  model_kit: ModelHandle,
  prompt: string | number[],
  params?: Omit<Partial<GeneratorParams>, 'model' | 'prompt'>
): Promise<string> {
  const tokens: string[] = [];

  for await (const chunk of create_generator(model_kit, prompt, params)) {
    if (chunk.type === 'token') {
      tokens.push(chunk.token);
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error.message);
    }
  }

  return tokens.join('');
}

/**
 * Unload a model (mlx-engine style).
 *
 * @param model_kit - Model handle to unload
 *
 * @example
 * ```typescript
 * const model_kit = await load_model("llama-3.1-8b");
 * // ... use model ...
 * await unload_model(model_kit);
 * ```
 */
export async function unload_model(model_kit: ModelHandle): Promise<void> {
  const engine = await getGlobalEngine();
  return engine.unloadModel(model_kit.descriptor.id);
}

/**
 * Shutdown the global engine instance.
 * Should be called when done with all module-level operations.
 *
 * @example
 * ```typescript
 * const model_kit = await load_model("llama");
 * // ... do work ...
 * await shutdown();
 * ```
 */
export async function shutdown(): Promise<void> {
  if (globalEngine) {
    await globalEngine.shutdown();
    globalEngine = null;
  }
}

/**
 * Get the global engine instance (for advanced use).
 * Returns null if not yet initialized.
 *
 * @example
 * ```typescript
 * const engine = getEngine();
 * if (engine) {
 *   const info = await engine.getRuntimeInfo();
 * }
 * ```
 */
export function getEngine(): Engine | null {
  return globalEngine;
}
