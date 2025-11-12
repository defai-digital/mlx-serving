#!/usr/bin/env tsx
/**
 * Worker Node Startup Script
 *
 * Starts a worker node and connects it to the distributed inference cluster.
 *
 * Usage:
 *   tsx scripts/start-worker.ts [--config path/to/cluster.yaml] [--worker-id <id>]
 *
 * Options:
 *   --config <path>    Path to cluster configuration (default: config/cluster.yaml)
 *   --worker-id <id>   Worker ID (default: auto-generated UUID)
 *   --help             Show this help message
 */

import { WorkerNode } from '../src/distributed/worker/worker-node.js';
import { loadClusterConfig } from '../src/distributed/config/loader.js';
import * as path from 'path';

interface StartWorkerOptions {
  configPath: string;
  workerId?: string;
}

/**
 * Parse command-line arguments
 */
function parseArgs(): StartWorkerOptions {
  const args = process.argv.slice(2);
  const options: StartWorkerOptions = {
    configPath: 'config/cluster.yaml',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;

      case '--config':
      case '-c':
        if (i + 1 >= args.length) {
          console.error('Error: --config requires a path argument');
          process.exit(1);
        }
        options.configPath = args[++i];
        break;

      case '--worker-id':
      case '-w':
        if (i + 1 >= args.length) {
          console.error('Error: --worker-id requires an ID argument');
          process.exit(1);
        }
        options.workerId = args[++i];
        break;

      default:
        console.error(`Error: Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Worker Node Startup Script

Starts a worker node and connects it to the distributed inference cluster.

Usage:
  tsx scripts/start-worker.ts [options]

Options:
  --config, -c <path>     Path to cluster configuration (default: config/cluster.yaml)
  --worker-id, -w <id>    Worker ID (default: auto-generated UUID)
  --help, -h              Show this help message

Examples:
  # Start with default config
  tsx scripts/start-worker.ts

  # Start with custom config
  tsx scripts/start-worker.ts --config my-cluster.yaml

  # Start with specific worker ID
  tsx scripts/start-worker.ts --worker-id worker-001

Environment Variables:
  KR_MLX_LOG_LEVEL    Set log level (debug, info, warn, error)

Signals:
  SIGINT (Ctrl+C)     Graceful shutdown
  SIGTERM             Graceful shutdown
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseArgs();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         mlx-serving Distributed Worker Node             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  let worker: WorkerNode | null = null;

  try {
    // 1. Load configuration
    console.log(`Loading configuration from: ${options.configPath}`);
    const configPath = path.resolve(options.configPath);
    const config = await loadClusterConfig(configPath);
    console.log('Configuration loaded ✓');
    console.log('');

    // 2. Create worker instance
    console.log('Creating worker node...');
    worker = new WorkerNode({
      config,
      workerId: options.workerId,
    });

    // Setup event handlers
    worker.on('stateChange', (state) => {
      console.log(`[Worker] State: ${state}`);
    });

    worker.on('ready', () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════╗');
      console.log('║                  Worker Node Ready                       ║');
      console.log('╚══════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`Worker ID:        ${worker!.getWorkerId()}`);
      console.log(`State:            ${worker!.getState()}`);
      console.log(`Active Requests:  ${worker!.getActiveRequests()}`);
      console.log('');
      console.log('Press Ctrl+C to stop the worker');
      console.log('');
    });

    worker.on('error', (error) => {
      console.error('Worker error:', error);
    });

    worker.on('stopped', () => {
      console.log('Worker stopped');
    });

    // 3. Start worker
    console.log('Starting worker node...');
    await worker.start();

    // 4. Setup graceful shutdown
    const shutdown = async (signal: string) => {
      console.log('');
      console.log(`Received ${signal}, shutting down gracefully...`);

      if (worker) {
        try {
          await worker.stop();
          console.log('Worker shutdown complete');
          process.exit(0);
        } catch (error) {
          console.error('Error during shutdown:', error);
          process.exit(1);
        }
      } else {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep process alive
    await new Promise(() => {
      /* Keep running until signal */
    });
  } catch (error) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║                   Startup Failed                         ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    console.error('');
    console.error('Error:', (error as Error).message);
    console.error('');

    if (error instanceof Error && error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }

    // Cleanup
    if (worker) {
      try {
        await worker.stop();
      } catch {
        // Ignore cleanup errors
      }
    }

    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
