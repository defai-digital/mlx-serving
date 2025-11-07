import { describe, it, expect, beforeEach } from 'vitest';
import { Engine } from '../../../src/api/engine.js';
import { StreamRegistry } from '../../../src/bridge/stream-registry.js';
import type { TokenizeResponse as TransportTokenizeResponse } from '../../../src/bridge/serializers.js';
import { pino } from 'pino';

class MockTransport {
  public calls: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly streamRegistry: StreamRegistry) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });

    switch (method) {
      case 'load_model':
        return {
          model_id: (params as { model_id: string }).model_id,
          state: 'ready',
          context_length: 4096,
        } as T;
      case 'unload_model':
        return { success: true } as T;
      case 'check_draft':
        return { compatible: true } as T;
      case 'tokenize':
        return {
          tokens: [1, 2, 3],
          token_strings: ['▁Hello', 'world', '!'],
        } satisfies TransportTokenizeResponse as T;
      case 'generate': {
        const { stream_id } = params as { stream_id: string };
        setTimeout(() => {
          this.streamRegistry.handleChunk({
            stream_id,
            token: 'H',
            token_id: 0,
            logprob: -0.2,
            is_final: false,
          });
          this.streamRegistry.handleStats({
            stream_id,
            tokens_generated: 1,
            tokens_per_second: 30,
            time_to_first_token: 0.01,
            total_time: 0.05,
          });
          this.streamRegistry.handleEvent({
            stream_id,
            event: 'completed',
            finish_reason: 'stop',
            is_final: true,
          });
        }, 0);
        return { stream_id, started_at: Date.now() } as T;
      }
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }
}

class MockRunner {
  public readonly streamRegistry: StreamRegistry;
  private transport: MockTransport | null = null;
  public startCalls = 0;
  public stopCalls = 0;

  constructor(streamRegistry: StreamRegistry, private readonly backingTransport: MockTransport) {
    this.streamRegistry = streamRegistry;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.transport = this.backingTransport;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.transport = null;
  }

  getTransport(): MockTransport | null {
    return this.transport;
  }
}

describe('Engine', () => {
  let streamRegistry: StreamRegistry;
  let transport: MockTransport;
  let runner: MockRunner;
  let engine: Engine;
  const telemetry = {
    models: [] as string[],
    tokens: [] as string[],
    completed: [] as number[],
    errors: [] as string[],
  };

  beforeEach(() => {
    streamRegistry = new StreamRegistry({ defaultTimeout: 1000, maxActiveStreams: 5 });
    transport = new MockTransport(streamRegistry);
    runner = new MockRunner(streamRegistry, transport);
    telemetry.models = [];
    telemetry.tokens = [];
    telemetry.completed = [];
    telemetry.errors = [];

    engine = new Engine(
      {
        telemetry: {
          enabled: true,
          hooks: {
            onModelLoaded: (handle) => telemetry.models.push(handle.descriptor.id),
            onTokenGenerated: (token) => telemetry.tokens.push(token),
            onGenerationCompleted: (stats) => telemetry.completed.push(stats.tokensGenerated),
            onError: (error) => telemetry.errors.push(error.message),
          },
        },
      },
      {
        runner: runner as never,
        logger: pino({ level: 'silent' }),
      }
    );
  });

  it('loads models and triggers telemetry', async () => {
    const handle = await engine.loadModel({ model: 'alpha' });
    expect(handle.descriptor.id).toBe('alpha');
    expect(telemetry.models).toContain('alpha');
  });

  it('supports snake_case load_model alias', async () => {
    const handle = await engine.load_model({ model: 'beta' });
    expect(handle.descriptor.id).toBe('beta');
  });

  it('tokenizes text using loaded model', async () => {
    await engine.loadModel({ model: 'alpha' });
    const tokens = await engine.tokenize({ model: 'alpha', text: 'Hello world!' });
    expect(tokens.tokens).toEqual([1, 2, 3]);
    expect(tokens.tokenStrings).toEqual(['▁Hello', 'world', '!']);
  });

  it('streams generation results', async () => {
    await engine.loadModel({ model: 'alpha' });

    const generator = engine.createGenerator({ model: 'alpha', prompt: 'Hello', streaming: true });
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
    expect(telemetry.tokens).toContain('H');
    expect(telemetry.completed).toContain(1);
  });

  it('normalizes snake_case generator parameters before transport call', async () => {
    await engine.loadModel({ model: 'alpha' });

    const generator = engine.create_generator({
      model: 'alpha',
      prompt: 'Hello snake_case',
      max_tokens: 4,
      presence_penalty: 0.25,
      stream: false,
    });

    const iterator = generator[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    const generateCall = transport.calls.find((call) => call.method === 'generate');
    expect(generateCall).toBeDefined();
    const params = generateCall?.params as Record<string, unknown>;
    expect(params?.max_tokens).toBe(4);
    expect(params?.presence_penalty).toBe(0.25);
    expect(params?.streaming).toBe(false);
  });

  it('normalizes snake_case tokenization parameters', async () => {
    await engine.loadModel({ model: 'alpha' });
    await engine.tokenize({ model: 'alpha', text: 'Normalize me', addBos: true });

    const lastCall = transport.calls[transport.calls.length - 1];
    expect(lastCall?.method).toBe('tokenize');
    const params = lastCall?.params as Record<string, unknown>;
    expect(params?.add_special_tokens).toBe(true);
    expect(params?.model_id).toBe('alpha');
  });

  it('shuts down the runner cleanly', async () => {
    await engine.loadModel({ model: 'alpha' });
    await engine.shutdown();
    expect(runner.stopCalls).toBe(1);
  });
});
