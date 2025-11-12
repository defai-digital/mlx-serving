/**
 * Controller Startup Script
 *
 * CLI to launch distributed inference controller node.
 */

import { ControllerNode } from '../src/distributed/controller/controller-node.js';
import { loadClusterConfig } from '../src/distributed/config/loader.js';
import { createLogger } from '../src/distributed/utils/logger.js';

const logger = createLogger('ControllerCLI');

/**
 * Main entry point
 */
async function main() {
  logger.info('Controller starting...');

  try {
    // 1. Load configuration
    const configPath = process.env.CLUSTER_CONFIG || 'config/cluster.yaml';
    const config = await loadClusterConfig(configPath);

    // 2. Check if controller mode is enabled
    if (!config.controller?.enabled) {
      logger.error('Controller mode is not enabled in configuration');
      logger.info('To enable controller mode, set cluster.controller.enabled: true in config/cluster.yaml');
      process.exit(1);
    }

    // 3. Create controller instance
    const controller = new ControllerNode({ config });

    // 4. Setup graceful shutdown
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn('Already shutting down, please wait...');
        return;
      }

      isShuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        await controller.stop();
        logger.info('Controller stopped successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error as Error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 5. Start controller
    await controller.start();

    // 6. Log startup info
    const port = config.controller.port ?? 8080;
    const bindAddress = config.controller.bindAddress ?? '0.0.0.0';
    const displayAddress = bindAddress === '0.0.0.0' ? 'localhost' : bindAddress;

    logger.info('✅ Controller is READY');
    console.log('\n' + '='.repeat(60));
    console.log('Controller Node Started Successfully');
    console.log('='.repeat(60));
    console.log('\nEndpoints:');
    console.log(`  - POST http://${displayAddress}:${port}/v1/chat/completions`);
    console.log(`  - GET  http://${displayAddress}:${port}/api/cluster/status`);
    console.log(`  - GET  http://${displayAddress}:${port}/api/cluster/workers`);
    console.log(`  - GET  http://${displayAddress}:${port}/api/cluster/workers/:id`);
    console.log(`  - GET  http://${displayAddress}:${port}/health`);
    console.log('\nConfiguration:');
    console.log(`  - NATS: ${config.nats.mode === 'external' ? config.nats.serverUrl : 'embedded'}`);
    console.log(`  - Heartbeat interval: ${config.discovery?.heartbeatIntervalMs ?? 5000}ms`);
    console.log(`  - Offline timeout: ${config.discovery?.offlineTimeoutMs ?? 15000}ms`);
    console.log(`  - Load balancing: ${config.loadBalancing?.strategy ?? 'smart'}`);
    console.log('\n' + '='.repeat(60));
    console.log('\nPress Ctrl+C to shutdown gracefully\n');

    // 7. Setup event handlers
    controller.on('workerRegistered', (registration) => {
      logger.info('Worker registered', {
        workerId: registration.workerId,
        hostname: registration.hostname,
        modelsCount: registration.skills.availableModels.length,
      });
    });

    controller.on('workerOffline', (worker) => {
      logger.warn('Worker offline', {
        workerId: worker.workerId,
        hostname: worker.hostname,
      });
    });

    // 8. Periodic status logging (every 60s)
    setInterval(() => {
      const status = controller.getClusterStatus();
      logger.info('Cluster status', {
        workers: {
          total: status.workers.total,
          online: status.workers.online,
          offline: status.workers.offline,
        },
        requests: {
          active: status.requests.active,
          total: status.requests.total,
        },
        uptime: Math.floor(status.controller.uptime / 1000) + 's',
      });
    }, 60000);
  } catch (error) {
    logger.error('Failed to start controller', error as Error);
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
