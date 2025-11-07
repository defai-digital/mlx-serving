import { describe, it, expect } from 'vitest';
import { GeneratorFactory } from '../../../src/core/generator-factory.js';
import { StreamRegistry } from '../../../src/bridge/stream-registry.js';

class MockTransport {
  constructor(private readonly handlers: { onGenerate?: (params: unknown) => void }) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === 'generate') {
      const typed = params as { stream_id: string };
      this.handlers.onGenerate?.(typed);
      return {
        stream_id: typed.stream_id,
        started_at: Date.now(),
      } as T;
    }
    throw new Error(`Unsupported method: ${method}`);
  }
}

describe('GeneratorFactory', () => {
  it('creates async generator that yields tokens and metadata', async () => {
    const streamRegistry = new StreamRegistry({
      defaultTimeout: 1000,
      maxActiveStreams: 5,
    });

    const telemetry = {
      tokens: [] as string[],
      completed: [] as number[],
      errors: [] as string[],
    };

    const transport = new MockTransport({
      onGenerate: (params: any) => {
        const { stream_id } = params;
        setTimeout(() => {
          streamRegistry.handleChunk({
            stream_id,
            token: 'H',
            token_id: 0,
            logprob: -0.1,
            is_final: false,
          });
          streamRegistry.handleStats({
            stream_id,
            tokens_generated: 1,
            tokens_per_second: 50,
            time_to_first_token: 0.02,
            total_time: 0.1,
          });
          streamRegistry.handleEvent({
            stream_id,
            event: 'completed',
            finish_reason: 'stop',
            is_final: true,
          });
        }, 0);
      },
    });

    const factory = new GeneratorFactory(transport as never, streamRegistry, {
      telemetry: {
        onTokenGenerated: (token) => telemetry.tokens.push(token),
        onGenerationCompleted: (stats) => telemetry.completed.push(stats.tokensGenerated),
        onError: (error) => telemetry.errors.push(error.message),
      },
    });

    const generator = factory.createGenerator({
      model: 'alpha',
      prompt: 'Hello',
      streaming: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const iterator = generator[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe('token');
    if (first.value?.type !== 'token') {
      throw new Error('Expected token chunk');
    }
    expect(first.value.token).toBe('H');

    const metadata = await iterator.next();
    expect(metadata.value?.type).toBe('metadata');
    if (metadata.value?.type !== 'metadata') {
      throw new Error('Expected metadata chunk');
    }

    expect(telemetry.tokens).toEqual(['H']);
    expect(telemetry.completed).toEqual([1]);
    expect(telemetry.errors).toHaveLength(0);
  });

  it('propagates stream errors to consumers', async () => {
    const streamRegistry = new StreamRegistry({
      defaultTimeout: 1000,
      maxActiveStreams: 5,
    });

    const telemetryErrors: string[] = [];

    const transport = new MockTransport({
      onGenerate: (params: any) => {
        const { stream_id } = params;
        setTimeout(() => {
          try {
            streamRegistry.handleChunk({
              stream_id,
              token: 'X',
              token_id: 0,
              logprob: -0.5,
              is_final: false,
            });
            streamRegistry.handleEvent({
              stream_id,
              event: 'error',
              error: 'runtime failure',
              is_final: true,
            });
          } catch (error) {
            // error surfaces via generator stream; swallow to keep test alive
          }
        }, 0);
      },
    });

    const factory = new GeneratorFactory(transport as never, streamRegistry, {
      telemetry: {
        onError: (error) => telemetryErrors.push(error.message),
      },
    });

    const generator = factory.createGenerator({
      model: 'alpha',
      prompt: 'Hello',
      streaming: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const iterator = generator[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe('token');
    if (first.value?.type !== 'token') {
      throw new Error('Expected token chunk');
    }
    expect(first.value.token).toBe('X');

    const errorChunk = await iterator.next();
    expect(errorChunk.value?.type).toBe('error');
    if (errorChunk.value?.type !== 'error') {
      throw new Error('Expected error chunk');
    }
    expect(errorChunk.value.error.message).toContain('runtime failure');

    expect(telemetryErrors).toContain('runtime failure');
  });
});
