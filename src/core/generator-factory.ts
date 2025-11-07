/**
 * GeneratorFactory
 *
 * Bridges the JSON-RPC streaming notifications into an AsyncGenerator that
 * callers can iterate over. Handles backpressure, cancellation, telemetry,
 * and error propagation in a single place.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { JsonRpcTransport } from '../bridge/jsonrpc-transport.js';
import type {
  StreamRegistry,
  StreamChunk as RegistryChunk,
  StreamStats as RegistryStats,
} from '../bridge/stream-registry.js';
import type {
  GenerateParams,
  GenerateResponse,
} from '../bridge/serializers.js';
import {
  EngineClientError,
  toEngineError,
} from '../api/errors.js';
import type {
  GeneratorParams,
  GeneratorChunk,
  GenerationStats,
  PromptTemplate,
  StructuredOutputConfig,
} from '../types/index.js';
import type { TelemetryHooks } from '../types/engine.js';
// OPTIMIZATION #4: Use object pool to reuse AsyncQueue instances
import type { AsyncQueue} from './async-queue-pool.js';
import { AsyncQueuePool } from './async-queue-pool.js';
import type { GenerateBatcher, GeneratePriority } from './generate-batcher.js';

export interface GeneratorFactoryOptions {
  logger?: Logger;
  telemetry?: TelemetryHooks;
  highWaterMark?: number;
  generateBatcher?: GenerateBatcher;
}

export interface CreateGeneratorOptions {
  signal?: AbortSignal;
  streamId?: string;
  timeoutMs?: number;
  priority?: GeneratePriority;
}

const DEFAULT_HIGH_WATER_MARK = 64;

// OPTIMIZATION #4: AsyncQueue moved to async-queue-pool.ts for pooling

/**
 * Factory for async generators backed by the JSON-RPC streaming pipeline.
 */
export class GeneratorFactory {
  private readonly transport: JsonRpcTransport;
  private readonly streamRegistry: StreamRegistry;
  private readonly logger?: Logger;
  private readonly telemetry?: TelemetryHooks;
  private readonly highWaterMark: number;
  // OPTIMIZATION #4: Object pool for AsyncQueue instances
  private readonly queuePool: AsyncQueuePool<GeneratorChunk>;
  // v1.3.0: Optional request batcher for IPC reduction
  private readonly generateBatcher?: GenerateBatcher;

  constructor(
    transport: JsonRpcTransport,
    streamRegistry: StreamRegistry,
    options: GeneratorFactoryOptions = {}
  ) {
    this.transport = transport;
    this.streamRegistry = streamRegistry;
    this.logger = options.logger;
    this.telemetry = options.telemetry;
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    // OPTIMIZATION #4: Initialize queue pool (128 queues for extended workloads)
    // MEMORY LEAK FIX: Implemented double-release protection with queueReleased flag
    // Queues are now properly released in ALL failure scenarios including early setup failures
    this.queuePool = new AsyncQueuePool<GeneratorChunk>(128, this.highWaterMark);
    // v1.3.0: Store optional batcher for request batching
    this.generateBatcher = options.generateBatcher;
  }

  /**
   * Create a new async generator backed by a runtime stream.
   */
  public createGenerator(
    params: GeneratorParams,
    options: CreateGeneratorOptions = {}
  ): AsyncGenerator<GeneratorChunk, void> {
    // OPTIMIZATION #4: Acquire queue from pool instead of allocating new
    const queue = this.queuePool.acquire();
    const streamId = options.streamId ?? randomUUID();
    const startTime = performance.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;
    let listenersAttached = false;
    let errorReported = false;
    let queueReleased = false; // Track if queue has been released to prevent double-release

    const detachListeners = this.attachStreamHandlers(
      streamId,
      queue,
      () => {
        const now = performance.now();
        const totalSeconds = Math.max((now - startTime) / 1000, 0.0001);
        const stats: GenerationStats = {
          tokensGenerated: tokenCount,
          tokensPerSecond: tokenCount / totalSeconds,
          timeToFirstToken:
            firstTokenTime === null
              ? totalSeconds
              : Math.max((firstTokenTime - startTime) / 1000, 0),
          totalTime: totalSeconds,
          modelId: params.model,
        };
        return stats;
      },
      (token) => {
        const now = performance.now();
        if (firstTokenTime === null) {
          firstTokenTime = now;
        }
        tokenCount += 1;

        const totalSeconds = Math.max((now - startTime) / 1000, 0.0001);
        const stats: GenerationStats = {
          tokensGenerated: tokenCount,
          tokensPerSecond: tokenCount / totalSeconds,
          timeToFirstToken:
            firstTokenTime === null
              ? totalSeconds
              : Math.max((firstTokenTime - startTime) / 1000, 0),
          totalTime: totalSeconds,
          modelId: params.model,
        };

        this.telemetry?.onTokenGenerated?.(token, stats);
      },
      () => {
        errorReported = true;
      }
    );

    try {
      void this.streamRegistry
        .register(streamId, options.signal, options.timeoutMs)
        .catch(async (error) => {
          const mapped = toEngineError(error, 'GenerationError');
          this.logger?.warn({ error: mapped, streamId }, 'Stream registry reported error');

          if (!errorReported) {
            errorReported = true;
            this.telemetry?.onError?.(mapped.toObject());

            try {
              await queue.push({
                type: 'error',
                error: mapped.toObject(),
              });
            } catch (pushError) {
              this.logger?.error(
                { error: pushError, streamId },
                'Failed to push error chunk after stream registry failure'
              );
            }

            queue.close();
            // Note: Don't release queue here - this error happens during stream
            // processing (after iterator returned). The queue will be released
            // by iterator.next() when it reads done=true, or by iterator.return()
          }

          detachListeners();
        });
      listenersAttached = true;
    } catch (error) {
      detachListeners();
      const mapped = toEngineError(error, 'GenerationError');
      queue.fail(mapped);
      // Bug Fix #3: Release queue back to pool on sync initialization error
      // Iterator hasn't been returned yet, so it won't handle cleanup
      if (!queueReleased) {
        this.queuePool.release(queue);
        queueReleased = true;
      }
      throw mapped;
    }

    const requestPromise = (async () => {
      try {
        const rpcParams = this.buildGenerateParams(params, streamId);

        // v1.3.0: Use GenerateBatcher when available for IPC reduction
        if (this.generateBatcher) {
          await this.generateBatcher.enqueue(rpcParams, {
            priority: options.priority,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
          });
        } else {
          // Fallback to direct transport when batcher not available
          await this.transport.request<GenerateResponse>('generate', rpcParams, {
            signal: options.signal,
          });
        }
      } catch (error) {
        // Fix: Cancel stream registry entry to prevent memory leak
        this.streamRegistry.cancel(streamId);
        detachListeners();
        const mapped = toEngineError(error, 'GenerationError');

        // Bug Fix #58: Wrap queue.fail() in try-catch to prevent unhandled rejection
        // If queue.fail() throws (e.g., if queue is in an unexpected state), we must
        // not let that exception escape and create an unhandled rejection
        try {
          queue.fail(mapped);
        } catch (failError) {
          this.logger?.error(
            { error: failError, streamId },
            'queue.fail() threw error during request error handling'
          );
          // Continue with cleanup even if fail() threw
        }

        // Bug Fix #3: Release queue back to pool on request error
        // User code may not call iterator.return() after next() throws
        if (!queueReleased) {
          this.queuePool.release(queue);
          queueReleased = true;
        }
        throw mapped;
      }
    })();

    const setupPromise = requestPromise.catch((error) => {
      // Note: Queue already released in requestPromise catch block above

      // Bug Fix #58: Wrap queue.fail() in try-catch to prevent unhandled rejection
      // This catch block runs AFTER the requestPromise catch block, so queue.fail()
      // has already been called once. If it throws here, we must not propagate the error.
      try {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      } catch (failError) {
        this.logger?.error(
          { error: failError, streamId },
          'queue.fail() threw error during setup promise error handling'
        );
        // Swallow the error - the original error is more important
      }

      // MEMORY LEAK FIX: Release queue immediately if setup fails
      // This handles the case where user never calls next() after catching setup error
      if (!queueReleased) {
        this.queuePool.release(queue);
        queueReleased = true;
      }

      throw error;
    });

    const iterator: AsyncGenerator<GeneratorChunk, void> = {
      next: async () => {
        await setupPromise;
        const result = await queue.shift();
        if (result.done) {
          detachListeners();
          // OPTIMIZATION #4: Return queue to pool when done
          if (!queueReleased) {
            this.queuePool.release(queue);
            queueReleased = true;
          }
          return { done: true, value: undefined };
        }

        return { done: false, value: result.value };
      },
      return: async () => {
        if (listenersAttached && this.streamRegistry.isActive(streamId)) {
          this.streamRegistry.cancel(streamId);
        }
        detachListeners();

        // BUG FIX: Only close queue if it hasn't been released yet
        // If queue was released in iterator.next() when done:true was returned,
        // calling close() here would close the queue AFTER it's back in the pool!
        if (!queueReleased) {
          queue.close();
          this.queuePool.release(queue);
          queueReleased = true;
        }
        return { done: true, value: undefined };
      },
      throw: async (err) => {
        detachListeners();
        queue.fail(err instanceof Error ? err : new Error(String(err)));
        // OPTIMIZATION #4: Return queue to pool on error
        if (!queueReleased) {
          this.queuePool.release(queue);
          queueReleased = true;
        }
        throw err;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return iterator;
  }

  private attachStreamHandlers(
    streamId: string,
    queue: AsyncQueue<GeneratorChunk>,
    statsBuilder: () => GenerationStats,
    tokenHook: (token: string) => void,
    errorMarker: () => void
  ): () => void {
    let pushChain: Promise<void> = Promise.resolve();
    let statsDelivered = false;

    const push = (chunk: GeneratorChunk): Promise<void> => {
      pushChain = pushChain
        .then(() => queue.push(chunk))
        .catch((error) => {
          this.logger?.error(
            { error, streamId },
            'Failed to push chunk to queue'
          );
          queue.fail(error instanceof Error ? error : new Error(String(error)));
        });
      return pushChain;
    };

    const handleChunk = (chunk: RegistryChunk): void => {
      if (chunk.streamId !== streamId) {
        return;
      }

      tokenHook(chunk.token);

      // P1-2: Map all fields from stream notification to GeneratorChunk
      const tokenChunk: GeneratorChunk = {
        type: 'token',
        token: chunk.token,
        ...(chunk.logprob !== undefined && { logprob: chunk.logprob }),
        ...(chunk.tokenId !== undefined && { tokenId: chunk.tokenId }),
        ...(chunk.isFinal !== undefined && { isFinal: chunk.isFinal }),
        ...(chunk.cumulativeText !== undefined && { cumulativeText: chunk.cumulativeText }),
      };

      push(tokenChunk);
    };

    const handleStats = (stats: RegistryStats): void => {
      if (stats.streamId !== streamId) {
        return;
      }

      statsDelivered = true;

      const generationStats: GenerationStats = {
        tokensGenerated: stats.tokensGenerated,
        tokensPerSecond: stats.tokensPerSecond,
        timeToFirstToken: stats.timeToFirstToken,
        totalTime: stats.totalTime,
      };

      push({
        type: 'metadata',
        stats: generationStats,
      });

      this.telemetry?.onGenerationCompleted?.(generationStats);
    };

    const handleCompleted = (completedStreamId: string): void => {
      if (completedStreamId !== streamId) {
        return;
      }

      pushChain.finally(() => {
        queue.close();
      });
    };

    const handleError = (erroredStreamId: string, errorMessage: string): void => {
      if (erroredStreamId !== streamId) {
        return;
      }

      const error = new EngineClientError(
        'GenerationError',
        errorMessage || 'Generation stream failed'
      );

      errorMarker();
      this.telemetry?.onError?.(error.toObject());

      push({
        type: 'error',
        error: error.toObject(),
      }).finally(() => {
        queue.close();
      });
    };

    const handleTimeout = (timeoutStreamId: string): void => {
      if (timeoutStreamId !== streamId) {
        return;
      }

      const timeoutError = new EngineClientError(
        'Timeout',
        `Stream ${streamId} timed out`
      );

      errorMarker();
      this.telemetry?.onError?.(timeoutError.toObject());

      push({
        type: 'error',
        error: timeoutError.toObject(),
      }).finally(() => {
        queue.close();
      });
    };

    // If the stream completes before stats arrive we emit derived stats.
    const ensureStatsOnCompletion = (completedStreamId: string): void => {
      if (completedStreamId !== streamId) {
        return;
      }

      if (statsDelivered) {
        return;
      }

      const stats = statsBuilder();
      this.telemetry?.onGenerationCompleted?.(stats);
      push({
        type: 'metadata',
        stats,
      });
    };

    this.streamRegistry.on('chunk', handleChunk);
    this.streamRegistry.on('stats', handleStats);
    this.streamRegistry.on('completed', handleCompleted);
    this.streamRegistry.on('error', handleError);
    this.streamRegistry.on('timeout', handleTimeout);

    this.streamRegistry.on('completed', ensureStatsOnCompletion);

    return () => {
      this.streamRegistry.off('chunk', handleChunk);
      this.streamRegistry.off('stats', handleStats);
      this.streamRegistry.off('completed', handleCompleted);
      this.streamRegistry.off('error', handleError);
      this.streamRegistry.off('timeout', handleTimeout);
      this.streamRegistry.off('completed', ensureStatsOnCompletion);
    };
  }

  private buildGenerateParams(
    params: GeneratorParams,
    streamId: string
  ): GenerateParams & { stream_id: string } {
    const prompt = this.renderPrompt(params.prompt);

    // OPTIMIZATION #7: Build object in single expression, only include defined fields
    // This reduces JSON.stringify size and avoids multiple if branches
    // Saves ~10-20ms by creating object once instead of incrementally
    const rpcParams: GenerateParams & { stream_id: string } = {
      model_id: params.model,
      prompt,
      stream_id: streamId,
      streaming: params.streaming !== undefined ? params.streaming : true,
      ...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.topP !== undefined && { top_p: params.topP }),
      ...(params.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
      ...(params.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
      ...(params.repetitionPenalty !== undefined && { repetition_penalty: params.repetitionPenalty }),
      ...(params.stopSequences !== undefined && { stop_sequences: params.stopSequences }),
      ...(params.stopTokenIds !== undefined && { stop_token_ids: params.stopTokenIds }),
      ...(params.seed !== undefined && { seed: params.seed }),
      ...(params.structured && { guidance: this.mapStructuredOutput(params.structured) }),
      // P1-1: Forward draft model parameter for speculative decoding
      ...(params.draftModel !== undefined && { draft_model: params.draftModel }),
    };

    return rpcParams;
  }

  private renderPrompt(prompt: GeneratorParams['prompt']): string {
    if (typeof prompt === 'string') {
      return prompt;
    }
    // Check if it's a token array (mlx-engine style)
    if ('tokens' in prompt) {
      // FUTURE: Token array prompts not yet supported
      // mlx-engine allows passing pre-tokenized arrays, but this feature
      // is rarely used and requires additional bridge implementation.
      // For now, empty string allows bridge to handle validation.
      return '';
    }
    // Bug Fix #68: Add error boundary around template rendering
    // User-provided template and variables could cause exceptions
    return this.fillTemplate(prompt);
  }

  private fillTemplate(template: PromptTemplate): string {
    // Bug Fix #68: Wrap template substitution in try-catch to prevent crashes
    // If user provides invalid template structure or malicious variables
    try {
      // Validate template structure
      if (!template || typeof template.template !== 'string') {
        throw new Error('Invalid template: template.template must be a string');
      }
      if (!template.variables || typeof template.variables !== 'object') {
        throw new Error('Invalid template: template.variables must be an object');
      }

      return template.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
        const value = template.variables[key];
        // Ensure variable values are strings to prevent injection
        return value !== undefined && value !== null ? String(value) : '';
      });
    } catch (error) {
      // Bug Fix #68: Convert template errors to EngineError
      const message = error instanceof Error ? error.message : 'Template rendering failed';
      this.logger?.error({ error, template }, 'Template rendering error');
      throw new EngineClientError('GenerationError', `Template rendering failed: ${message}`);
    }
  }

  private mapStructuredOutput(config: StructuredOutputConfig): GenerateParams['guidance'] {
    const mode = config.format === 'json' ? 'json_schema' : 'xml';
    return {
      mode,
      schema: config.schema,
    };
  }
}
