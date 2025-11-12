/**
 * Test Cluster Helper
 * Utilities for integration testing with real controller and workers
 */

import { ControllerNode } from '@/distributed/controller/controller-node.js';
import { WorkerNode } from '@/distributed/worker/worker-node.js';
import { EmbeddedNatsServer } from '@/distributed/nats/embedded-server.js';
import { loadClusterConfig } from '@/distributed/config/loader.js';
import type { ClusterConfig } from '@/distributed/types/config.js';
import { createLogger } from '@/distributed/utils/logger.js';

const logger = createLogger('TestCluster');

export interface TestClusterOptions {
  workerCount: number;
  natsPort?: number;
  controllerPort?: number;
  enableNats?: boolean;
}

export class TestCluster {
  private natsServer?: EmbeddedNatsServer;
  private controller?: ControllerNode;
  private workers: WorkerNode[] = [];
  private config?: ClusterConfig;

  constructor(private options: TestClusterOptions) {}

  /**
   * Start the test cluster
   */
  async start(): Promise<void> {
    logger.info('Starting test cluster', {
      workerCount: this.options.workerCount,
      natsPort: this.options.natsPort,
    });

    // 1. Load config
    this.config = await loadClusterConfig('config/cluster.yaml');

    // Override ports if provided
    if (this.options.natsPort) {
      if (this.config.nats.embedded) {
        this.config.nats.embedded.port = this.options.natsPort;
      }
    }
    if (this.options.controllerPort) {
      if (this.config.controller) {
        this.config.controller.port = this.options.controllerPort;
      }
    }

    // 2. Start NATS server
    if (this.options.enableNats !== false) {
      this.natsServer = new EmbeddedNatsServer();
      await this.natsServer.start({
        port: this.options.natsPort || 4222,
        httpPort: 8222,
        logLevel: 'info',
      });
      logger.info('NATS server started', { port: this.natsServer.getPort() });

      // Wait for NATS to be ready
      await this.delay(1000);
    }

    // 3. Start controller
    this.controller = new ControllerNode({ config: this.config });
    await this.controller.start();
    logger.info('Controller started');

    // Wait for controller to be ready
    await this.delay(1000);

    // 4. Start workers
    for (let i = 0; i < this.options.workerCount; i++) {
      const worker = new WorkerNode({ config: this.config });
      await worker.start();
      this.workers.push(worker);
      logger.info(`Worker ${i + 1} started`, { workerId: worker.getWorkerId() });

      // Small delay between workers
      await this.delay(500);
    }

    // 5. Wait for all workers to register
    await this.delay(2000);

    logger.info('Test cluster started successfully', {
      controller: this.controller.getState(),
      workers: this.workers.length,
    });
  }

  /**
   * Stop the test cluster
   */
  async stop(): Promise<void> {
    logger.info('Stopping test cluster');

    // 1. Stop workers
    for (const worker of this.workers) {
      try {
        await worker.stop();
      } catch (error) {
        logger.error('Error stopping worker', error as Error);
      }
    }

    // 2. Stop controller
    if (this.controller) {
      try {
        await this.controller.stop();
      } catch (error) {
        logger.error('Error stopping controller', error as Error);
      }
    }

    // 3. Stop NATS
    if (this.natsServer) {
      try {
        await this.natsServer.stop();
      } catch (error) {
        logger.error('Error stopping NATS', error as Error);
      }
    }

    logger.info('Test cluster stopped');
  }

  /**
   * Get controller instance
   */
  getController(): ControllerNode {
    if (!this.controller) {
      throw new Error('Controller not started');
    }
    return this.controller;
  }

  /**
   * Get worker instances
   */
  getWorkers(): WorkerNode[] {
    return this.workers;
  }

  /**
   * Get worker by index
   */
  getWorker(index: number): WorkerNode {
    if (index < 0 || index >= this.workers.length) {
      throw new Error(`Worker index ${index} out of range`);
    }
    return this.workers[index];
  }

  /**
   * Wait for condition
   */
  async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number = 10000,
    checkIntervalMs: number = 100
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await Promise.resolve(condition());
      if (result) return;

      await this.delay(checkIntervalMs);
    }

    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get cluster config
   */
  getConfig(): ClusterConfig {
    if (!this.config) {
      throw new Error('Config not loaded');
    }
    return this.config;
  }

  /**
   * Get controller API URL
   */
  getApiUrl(): string {
    const port = this.options.controllerPort || 8080;
    return `http://localhost:${port}`;
  }
}
