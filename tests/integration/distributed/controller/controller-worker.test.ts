import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCluster } from '../../helpers/test-cluster.js';

describe('Controller-Worker Integration', () => {
  let cluster: TestCluster;

  beforeAll(async () => {
    // Start cluster with 1 worker
    cluster = new TestCluster({
      workerCount: 1,
      natsPort: 4333, // Use different port to avoid conflicts
      controllerPort: 8181,
    });

    await cluster.start();
  }, 30000); // 30s timeout for startup

  afterAll(async () => {
    if (cluster) {
      await cluster.stop();
    }
  }, 10000); // 10s timeout for shutdown

  it('should register worker on startup', async () => {
    const controller = cluster.getController();
    const workers = controller.getAllWorkers();

    expect(workers.length).toBe(1);
    expect(workers[0].status).toBe('online');
    expect(workers[0].skills.availableModels.length).toBeGreaterThanOrEqual(0);
  });

  it('should receive worker heartbeats', async () => {
    const controller = cluster.getController();
    const worker = controller.getAllWorkers()[0];
    const initialHeartbeat = worker.lastHeartbeat;

    // Wait for next heartbeat (5s interval + buffer)
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(worker.workerId);
        return updated ? updated.lastHeartbeat > initialHeartbeat : false;
      },
      10000
    );

    const updated = controller.getWorker(worker.workerId);
    expect(updated?.lastHeartbeat).toBeGreaterThan(initialHeartbeat);
  });

  it('should update worker metrics from heartbeat', async () => {
    const controller = cluster.getController();
    const worker = controller.getAllWorkers()[0];

    // Wait for heartbeat with metrics
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(worker.workerId);
        return updated?.metrics !== undefined;
      },
      10000
    );

    const updated = controller.getWorker(worker.workerId);
    expect(updated?.metrics).toBeDefined();
    expect(updated?.metrics?.totalRequestsHandled).toBeDefined();
  });

  it('should detect offline workers after timeout', async () => {
    const controller = cluster.getController();
    const worker = cluster.getWorker(0);
    const workerId = worker.getWorkerId();

    // Stop worker
    await worker.stop();

    // Wait for offline detection (15s timeout + buffer)
    await cluster.waitFor(
      () => {
        const updated = controller.getWorker(workerId);
        return updated?.status === 'offline';
      },
      20000
    );

    const updated = controller.getWorker(workerId);
    expect(updated?.status).toBe('offline');
  }, 30000);

  it('should track worker count correctly', () => {
    const controller = cluster.getController();
    const workerCount = controller.getWorkerCount();
    expect(workerCount).toBe(1);
  });

  it('should return cluster status', () => {
    const controller = cluster.getController();
    const status = controller.getClusterStatus();

    expect(status.controller).toBeDefined();
    expect(status.controller.state).toBe('ready');
    expect(status.workers).toBeDefined();
    expect(status.workers.total).toBe(1);
  });

  it('should handle multiple workers', async () => {
    // Create new cluster with 2 workers
    const multiCluster = new TestCluster({
      workerCount: 2,
      natsPort: 4334,
      controllerPort: 8182,
    });

    try {
      await multiCluster.start();

      const controller = multiCluster.getController();
      const workers = controller.getAllWorkers();

      expect(workers.length).toBe(2);
      expect(workers.filter(w => w.status === 'online').length).toBe(2);
    } finally {
      await multiCluster.stop();
    }
  }, 45000);

  it('should identify controller state correctly', () => {
    const controller = cluster.getController();
    const state = controller.getState();

    expect(state).toBe('ready');
  });
});
