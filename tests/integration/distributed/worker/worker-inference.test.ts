import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { NatsClient } from '@/distributed/nats/client.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import type {
  InferenceRequest,
  StreamingResponse,
  StreamingTokenResponse,
  StreamingDoneResponse,
  StreamingErrorResponse,
} from '@/distributed/types/messages.js';
import { randomUUID } from 'crypto';

describe('Worker Inference (Integration)', () => {
  let embeddedServer: EmbeddedNatsServer;
  let worker: WorkerNode;
  let testClient: NatsClient;
  let config: ClusterConfig;
  let serverUrl: string;

  beforeAll(async () => {
    // Start embedded NATS server
    embeddedServer = new EmbeddedNatsServer();
    await embeddedServer.start();
    serverUrl = embeddedServer.getServerUrl();

    // Create config
    config = {
      mode: 'worker',
      nats: {
        mode: 'external',
        server_url: serverUrl,
      },
      worker: {
        port: 8080,
        model_dir: 'test-models',
      },
      discovery: {
        enabled: true,
        heartbeat_interval_ms: 5000,
        offline_timeout_ms: 15000,
      },
      runtime: {
        // Use minimal settings for fast tests
        model_concurrency_limiter: {
          enabled: true,
          tier_limits: {
            '<3B': {
              max_concurrent: 1,
              queue_depth: 5,
              queue_timeout_ms: 30000,
            },
          },
        },
      },
    } as ClusterConfig;

    // Create test client
    testClient = new NatsClient();
    await testClient.connect({ mode: 'external', server_url: serverUrl });

    // Start worker
    worker = new WorkerNode({ config });
    await worker.start();

    // Wait for worker to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60000);

  afterAll(async () => {
    if (worker) {
      await worker.stop();
    }
    if (testClient) {
      await testClient.disconnect();
    }
    if (embeddedServer) {
      await embeddedServer.stop();
    }
  }, 30000);

  it('should execute inference request end-to-end', async () => {
    const requestId = randomUUID();
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    // Collect response tokens
    const tokens: string[] = [];
    let done = false;
    let error: string | null = null;

    // Subscribe to response
    await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'token') {
        tokens.push(msg.token);
      } else if (msg.type === 'done') {
        done = true;
      } else if (msg.type === 'error') {
        error = msg.error;
      }
    });

    // Send inference request
    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Hello, how are you?',
      maxTokens: 10,
      temperature: 0.7,
    };

    await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);

    // Wait for completion (max 60s)
    await waitForCondition(() => done || error !== null, 60000, 100);

    // Verify response
    expect(error).toBeNull();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.length).toBeLessThanOrEqual(10);
    expect(done).toBe(true);
  }, 90000);

  it('should stream tokens with correct indices', async () => {
    const requestId = randomUUID();
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    const tokenResponses: StreamingTokenResponse[] = [];
    let done = false;

    await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'token') {
        tokenResponses.push(msg as StreamingTokenResponse);
      } else if (msg.type === 'done') {
        done = true;
      }
    });

    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Count to five:',
      maxTokens: 10,
      temperature: 0.7,
    };

    await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);

    await waitForCondition(() => done, 60000, 100);

    // Verify token indices are sequential
    expect(tokenResponses.length).toBeGreaterThan(0);
    for (let i = 0; i < tokenResponses.length; i++) {
      expect(tokenResponses[i].index).toBe(i);
      expect(tokenResponses[i].requestId).toBe(requestId);
    }
  }, 90000);

  it('should send done message with correct metrics', async () => {
    const requestId = randomUUID();
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    let doneResponse: StreamingDoneResponse | null = null;
    const tokens: string[] = [];

    await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'token') {
        tokens.push(msg.token);
      } else if (msg.type === 'done') {
        doneResponse = msg as StreamingDoneResponse;
      }
    });

    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Hello',
      maxTokens: 5,
      temperature: 0.7,
    };

    await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);

    await waitForCondition(() => doneResponse !== null, 60000, 100);

    expect(doneResponse).toBeDefined();
    expect(doneResponse!.requestId).toBe(requestId);
    expect(doneResponse!.totalTokens).toBe(tokens.length);
    expect(doneResponse!.latencyMs).toBeGreaterThan(0);
  }, 90000);

  it('should load model if not already loaded', async () => {
    const requestId = randomUUID();
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    let done = false;
    let error: string | null = null;

    await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'done') {
        done = true;
      } else if (msg.type === 'error') {
        error = msg.error;
      }
    });

    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Test',
      maxTokens: 3,
    };

    await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);

    await waitForCondition(() => done || error !== null, 60000, 100);

    // Should succeed (model loaded if needed)
    expect(error).toBeNull();
    expect(done).toBe(true);
  }, 90000);

  it('should handle multiple concurrent requests', async () => {
    const numRequests = 3;
    const requests: InferenceRequest[] = [];
    const results: Map<string, { done: boolean; error: string | null }> = new Map();

    // Create multiple requests
    for (let i = 0; i < numRequests; i++) {
      const requestId = randomUUID();
      requests.push({
        requestId,
        modelId: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        prompt: `Request ${i}:`,
        maxTokens: 5,
        temperature: 0.7,
      });

      results.set(requestId, { done: false, error: null });

      // Subscribe to each response
      await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
        const result = results.get(requestId)!;
        if (msg.type === 'done') {
          result.done = true;
        } else if (msg.type === 'error') {
          result.error = msg.error;
        }
      });
    }

    // Send all requests
    for (const request of requests) {
      await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);
    }

    // Wait for all to complete
    await waitForCondition(
      () => Array.from(results.values()).every((r) => r.done || r.error !== null),
      90000,
      100,
    );

    // Verify all succeeded
    for (const result of results.values()) {
      expect(result.done).toBe(true);
      expect(result.error).toBeNull();
    }
  }, 120000);

  it('should handle invalid model gracefully', async () => {
    const requestId = randomUUID();
    const modelId = 'invalid/nonexistent-model';

    let errorResponse: StreamingErrorResponse | null = null;

    await testClient.subscribe<StreamingResponse>(`response.${requestId}`, (msg) => {
      if (msg.type === 'error') {
        errorResponse = msg as StreamingErrorResponse;
      }
    });

    const request: InferenceRequest = {
      requestId,
      modelId,
      prompt: 'Test',
      maxTokens: 5,
    };

    await testClient.publish(`worker.${worker.getWorkerId()}.inference`, request);

    await waitForCondition(() => errorResponse !== null, 60000, 100);

    expect(errorResponse).toBeDefined();
    expect(errorResponse!.requestId).toBe(requestId);
    expect(errorResponse!.error).toBeTruthy();
    expect(errorResponse!.code).toBeTruthy();
  }, 90000);
});

/**
 * Wait for a condition to become true
 */
async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
