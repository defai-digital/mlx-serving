import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { NatsClient } from '@/distributed/nats/client.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import type { WorkerHeartbeat } from '@/distributed/types/messages.js';

describe('Worker Heartbeat (Integration)', () => {
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

    // Create config with shorter heartbeat interval for testing
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
        heartbeat_interval_ms: 1000, // 1 second for testing
        offline_timeout_ms: 3000,
      },
      runtime: {},
    } as ClusterConfig;

    // Create test client
    testClient = new NatsClient();
    await testClient.connect({ mode: 'external', server_url: serverUrl });

    // Start worker
    worker = new WorkerNode({ config });
    await worker.start();
  }, 30000);

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

  it('should send heartbeat messages periodically', async () => {
    const heartbeats: WorkerHeartbeat[] = [];

    // Subscribe to heartbeat messages
    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      heartbeats.push(msg);
    });

    // Wait for multiple heartbeats (at least 3 seconds for 3 heartbeats at 1s interval)
    await new Promise((resolve) => setTimeout(resolve, 3500));

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('should include worker ID in heartbeat', async () => {
    let heartbeat: WorkerHeartbeat | null = null;

    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      if (!heartbeat) heartbeat = msg;
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(heartbeat).toBeDefined();
    expect(heartbeat!.workerId).toBe(worker.getWorkerId());
  }, 30000);

  it('should include metrics in heartbeat', async () => {
    let heartbeat: WorkerHeartbeat | null = null;

    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      if (!heartbeat) heartbeat = msg;
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(heartbeat).toBeDefined();
    expect(heartbeat!.metrics).toBeDefined();
    expect(heartbeat!.metrics.cpuUsagePercent).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.metrics.cpuUsagePercent).toBeLessThanOrEqual(100);
    expect(heartbeat!.metrics.memoryUsedGB).toBeGreaterThan(0);
    expect(heartbeat!.metrics.gpuUtilizationPercent).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.metrics.activeRequests).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.metrics.totalRequestsHandled).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(heartbeat!.metrics.modelsLoaded).toBeInstanceOf(Array);
  }, 30000);

  it('should include status in heartbeat', async () => {
    let heartbeat: WorkerHeartbeat | null = null;

    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      if (!heartbeat) heartbeat = msg;
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(heartbeat).toBeDefined();
    expect(['online', 'offline', 'degraded']).toContain(heartbeat!.status);
  }, 30000);

  it('should include timestamp in heartbeat', async () => {
    let heartbeat: WorkerHeartbeat | null = null;

    const beforeHeartbeat = Date.now();
    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      if (!heartbeat) heartbeat = msg;
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterHeartbeat = Date.now();

    expect(heartbeat).toBeDefined();
    expect(heartbeat!.timestamp).toBeGreaterThanOrEqual(beforeHeartbeat);
    expect(heartbeat!.timestamp).toBeLessThanOrEqual(afterHeartbeat);
  }, 30000);

  it('should stop sending heartbeats after worker stops', async () => {
    const heartbeatsBeforeStop: WorkerHeartbeat[] = [];
    const heartbeatsAfterStop: WorkerHeartbeat[] = [];
    let workerStopped = false;

    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      if (!workerStopped) {
        heartbeatsBeforeStop.push(msg);
      } else {
        heartbeatsAfterStop.push(msg);
      }
    });

    // Wait for some heartbeats
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Stop worker
    await worker.stop();
    workerStopped = true;

    // Wait to ensure no more heartbeats
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(heartbeatsBeforeStop.length).toBeGreaterThan(0);
    expect(heartbeatsAfterStop.length).toBe(0);
  }, 30000);

  it('should update metrics over time', async () => {
    const heartbeats: WorkerHeartbeat[] = [];

    await testClient.subscribe<WorkerHeartbeat>('worker.heartbeat', (msg) => {
      heartbeats.push(msg);
    });

    // Wait for multiple heartbeats
    await new Promise((resolve) => setTimeout(resolve, 3500));

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    // Check that timestamps are different
    const timestamps = heartbeats.map((h) => h.timestamp);
    const uniqueTimestamps = new Set(timestamps);
    expect(uniqueTimestamps.size).toBe(heartbeats.length);
  }, 30000);
});
