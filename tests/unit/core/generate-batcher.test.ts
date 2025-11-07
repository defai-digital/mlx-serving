import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import type { JsonRpcTransport } from '../../../src/bridge/jsonrpc-transport.js';
import type { StreamRegistry, AggregateMetrics } from '../../../src/bridge/stream-registry.js';
import type { GenerateResponse } from '../../../src/bridge/serializers.js';
import { GenerateBatcher } from '../../../src/core/generate-batcher.js';

class StreamRegistryStub extends EventEmitter {
  public cancel = vi.fn();
  public active = 0;
  public currentLimit = 64;

  public getActiveCount = vi.fn(() => this.active);

  public getAggregateMetrics = vi.fn((): AggregateMetrics => ({
    timestamp: Date.now(),
    activeStreams: this.active,
    totalStreams: this.active,
    completedStreams: 0,
    cancelledStreams: 0,
    averageTTFT: 0,
    averageThroughput: 0,
    currentLimit: this.currentLimit,
    utilizationRate: this.currentLimit === 0 ? 0 : this.active / this.currentLimit,
  }));
}

describe('GenerateBatcher', () => {
  let transport: Partial<JsonRpcTransport>;
  let streamRegistryStub: StreamRegistryStub;
  let streamRegistry: StreamRegistry;
  let batcher: GenerateBatcher;

  beforeEach(() => {
    vi.useFakeTimers();

    streamRegistryStub = new StreamRegistryStub();
    streamRegistry = streamRegistryStub as unknown as StreamRegistry;

    transport = {
      request: vi.fn() as unknown as JsonRpcTransport['request'],
    };

    batcher = new GenerateBatcher(
      transport as JsonRpcTransport,
      streamRegistry,
      {
        minBatchSize: 2,
        maxBatchSize: 6,
        minHoldMs: 1,
        maxHoldMs: 3,
        backgroundHoldExtensionMs: 1,
        targetBatchTimeMs: 20,
        pauseOnBackpressureMs: 5,
      }
    );
  });

  afterEach(() => {
    batcher.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const buildResponse = (requests: Array<{ stream_id: string }>): { results: Array<{ success: boolean; result: GenerateResponse; error: null }> } => ({
    results: requests.map((req) => ({
      success: true,
      result: {
        stream_id: req.stream_id,
        started_at: Date.now(),
      },
      error: null,
    })),
  });

  it('batches default priority requests after hold window', async () => {
    const mockRequest = transport.request as ReturnType<typeof vi.fn>;
    mockRequest.mockImplementation(async (_method: string, params: { requests: Array<{ stream_id: string }> }) => buildResponse(params.requests));

    const promise1 = batcher.enqueue({
      model_id: 'model-a',
      prompt: 'Hello',
      stream_id: 'stream-1',
    });
    const promise2 = batcher.enqueue({
      model_id: 'model-a',
      prompt: 'World',
      stream_id: 'stream-2',
    });

    await vi.advanceTimersByTimeAsync(2);

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.stream_id).toBe('stream-1');
    expect(result2.stream_id).toBe('stream-2');

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [method, payload] = mockRequest.mock.calls[0];
    expect(method).toBe('batch_generate');
    expect(payload).toEqual({
      requests: [
        expect.objectContaining({ stream_id: 'stream-1' }),
        expect.objectContaining({ stream_id: 'stream-2' }),
      ],
    });
  });

  it('flushes immediately when urgent priority request arrives', async () => {
    const mockRequest = transport.request as ReturnType<typeof vi.fn>;
    mockRequest.mockImplementation(async (_method: string, params: { requests: Array<{ stream_id: string }> }) => buildResponse(params.requests));

    const backgroundPromise = batcher.enqueue(
      {
        model_id: 'model-a',
        prompt: 'Background',
        stream_id: 'bg-1',
      },
      { priority: 'background' }
    );

    // Urgent request should trigger immediate dispatch (no timer advance required)
    const urgentPromise = batcher.enqueue(
      {
        model_id: 'model-a',
        prompt: 'Urgent',
        stream_id: 'urgent-1',
      },
      { priority: 'urgent' }
    );

    await Promise.all([backgroundPromise, urgentPromise]);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [, payload] = mockRequest.mock.calls[0];
    const requests = (payload as { requests: Array<{ stream_id: string }> }).requests;
    expect(requests[0].stream_id).toBe('urgent-1');
    expect(new Set(requests.map((req) => req.stream_id))).toEqual(new Set(['urgent-1', 'bg-1']));
  });

  it('rejects requests when aborted before dispatch', async () => {
    const mockRequest = transport.request as ReturnType<typeof vi.fn>;
    mockRequest.mockImplementation(async (_method: string, params: { requests: Array<{ stream_id: string }> }) => buildResponse(params.requests));

    const controller = new AbortController();
    const promise = batcher.enqueue(
      {
        model_id: 'model-a',
        prompt: 'Abort me',
        stream_id: 'abort-1',
      },
      { signal: controller.signal }
    );

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(streamRegistryStub.cancel).toHaveBeenCalledWith('abort-1');
    expect(transport.request).not.toHaveBeenCalled();
    const stats = batcher.getStats();
    expect(stats.abortedRequests).toBe(1);
  });

  it('increases target batch size when latency is low', async () => {
    const mockRequest = transport.request as ReturnType<typeof vi.fn>;
    mockRequest.mockImplementation(async (_method: string, params: { requests: Array<{ stream_id: string }> }) => buildResponse(params.requests));

    const promises = [
      batcher.enqueue({
        model_id: 'model-a',
        prompt: 'First',
        stream_id: 'stream-1',
      }),
      batcher.enqueue({
        model_id: 'model-a',
        prompt: 'Second',
        stream_id: 'stream-2',
      }),
    ];

    await vi.advanceTimersByTimeAsync(2);
    await Promise.all(promises);

    const stats = batcher.getStats();
    expect(stats.partitions).toHaveLength(1);
    const partition = stats.partitions[0];
    expect(partition.targetBatchSize).toBeGreaterThanOrEqual(4);
  });
});

