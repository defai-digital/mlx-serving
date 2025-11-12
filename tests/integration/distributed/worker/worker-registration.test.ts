import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { NatsClient } from '@/distributed/nats/client.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import type { WorkerRegistration } from '@/distributed/types/messages.js';

describe('Worker Registration (Integration)', () => {
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
      runtime: {},
    } as ClusterConfig;

    // Create test client
    testClient = new NatsClient();
    await testClient.connect({ mode: 'external', server_url: serverUrl });
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

  it('should register with cluster on startup', async () => {
    let registrationReceived = false;
    let registration: WorkerRegistration | null = null;

    // Subscribe to registration messages
    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registrationReceived = true;
      registration = msg;
    });

    // Start worker
    worker = new WorkerNode({ config });
    await worker.start();

    // Wait for registration
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registrationReceived).toBe(true);
    expect(registration).toBeDefined();
  }, 30000);

  it('should include correct worker ID in registration', async () => {
    let registration: WorkerRegistration | null = null;

    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registration = msg;
    });

    worker = new WorkerNode({ config });
    await worker.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registration).toBeDefined();
    expect(registration!.workerId).toBe(worker.getWorkerId());
  }, 30000);

  it('should include hardware info in registration', async () => {
    let registration: WorkerRegistration | null = null;

    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registration = msg;
    });

    worker = new WorkerNode({ config });
    await worker.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registration).toBeDefined();
    expect(registration!.hostname).toBeTruthy();
    expect(registration!.ip).toBeTruthy();
    expect(registration!.port).toBe(8080);
  }, 30000);

  it('should include skills in registration', async () => {
    let registration: WorkerRegistration | null = null;

    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registration = msg;
    });

    worker = new WorkerNode({ config });
    await worker.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registration).toBeDefined();
    expect(registration!.skills).toBeDefined();
    expect(registration!.skills.availableModels).toBeInstanceOf(Array);
    expect(registration!.skills.modelPaths).toBeDefined();
    expect(registration!.skills.totalModelSize).toBeGreaterThanOrEqual(0);
    expect(registration!.skills.lastScanned).toBeGreaterThan(0);
  }, 30000);

  it('should set status to online in registration', async () => {
    let registration: WorkerRegistration | null = null;

    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registration = msg;
    });

    worker = new WorkerNode({ config });
    await worker.start();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registration).toBeDefined();
    expect(registration!.status).toBe('online');
  }, 30000);

  it('should include timestamp in registration', async () => {
    let registration: WorkerRegistration | null = null;

    await testClient.subscribe<WorkerRegistration>('worker.register', (msg) => {
      registration = msg;
    });

    const beforeStart = Date.now();
    worker = new WorkerNode({ config });
    await worker.start();
    const afterStart = Date.now();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(registration).toBeDefined();
    expect(registration!.timestamp).toBeGreaterThanOrEqual(beforeStart);
    expect(registration!.timestamp).toBeLessThanOrEqual(afterStart + 1000);
  }, 30000);
});
