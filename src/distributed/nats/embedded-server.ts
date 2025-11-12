/**
 * Embedded NATS server for distributed inference system
 *
 * Spawns and manages a NATS server process for local development and testing.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createLogger, type Logger } from '../utils/logger.js';
import { EmbeddedServerError } from '../utils/errors.js';
import type { EmbeddedServerOptions } from '../types/index.js';

/**
 * Embedded NATS server manager
 *
 * @example
 * ```typescript
 * const server = new EmbeddedNatsServer();
 * await server.start({ port: 4222, httpPort: 8222 });
 *
 * console.log('Server running on port:', server.getPort());
 *
 * // Later...
 * await server.stop();
 * ```
 */
export class EmbeddedNatsServer {
  private process?: ChildProcess;
  private running = false;
  private readonly logger: Logger;
  private readonly logs: string[] = [];
  private port = 4222;

  constructor() {
    this.logger = createLogger('EmbeddedNatsServer');
  }

  /**
   * Start the embedded NATS server
   *
   * @param options - Server configuration options
   * @throws {EmbeddedServerError} if server fails to start
   */
  async start(options?: EmbeddedServerOptions): Promise<void> {
    const opts = options ?? {};
    if (this.running) {
      this.logger.warn('Server already running');
      return;
    }

    // Use random ports in test environment to avoid conflicts
    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    const port = opts.port ?? (isTest ? this.getRandomPort(5000, 6000) : 4222);
    const httpPort = opts.httpPort ?? (isTest ? this.getRandomPort(9000, 10000) : 8222);
    const _logLevel = opts.logLevel ?? 'info';

    this.port = port;

    this.logger.info('Starting embedded NATS server', { port, httpPort });

    try {
      // Check if nats-server is available
      await this.checkNatsServerAvailable();

      // Build command line arguments
      const args = this.buildArgs(opts);

      // Spawn nats-server process
      this.process = spawn('nats-server', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Capture stdout
      this.process.stdout?.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        this.logs.push(message);
        this.logger.debug('NATS stdout', { message });
      });

      // Capture stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        this.logs.push(message);
        this.logger.warn('NATS stderr', { message });
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.running = false;
        if (code !== 0 && code !== null) {
          this.logger.error('NATS server exited unexpectedly', undefined, {
            code,
            signal,
          });
        } else {
          this.logger.info('NATS server stopped', { code, signal });
        }
      });

      // Handle process errors
      this.process.on('error', (error: Error) => {
        this.running = false;
        this.logger.error('NATS server process error', error);
      });

      // Wait for server to be ready
      await this.waitForReady(port);

      this.running = true;
      this.logger.info('NATS server started successfully', { port, httpPort });
    } catch (error) {
      this.logger.error('Failed to start NATS server', error as Error);
      throw new EmbeddedServerError(
        `Failed to start NATS server: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  /**
   * Stop the embedded NATS server
   */
  async stop(): Promise<void> {
    if (!this.running || !this.process) {
      this.logger.warn('Server not running');
      return;
    }

    this.logger.info('Stopping embedded NATS server');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.logger.warn('Server did not stop gracefully, killing');
        this.process?.kill('SIGKILL');
        this.running = false;
        resolve();
      }, 5000);

      this.process!.once('exit', () => {
        clearTimeout(timeout);
        this.running = false;
        this.process = undefined;
        this.logger.info('NATS server stopped');
        resolve();
      });

      this.process!.once('error', (error: Error) => {
        clearTimeout(timeout);
        this.running = false;
        this.logger.error('Error stopping NATS server', error);
        reject(error);
      });

      // Send SIGTERM for graceful shutdown
      this.process!.kill('SIGTERM');
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get server logs
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Get a random port in the specified range
   */
  private getRandomPort(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Check if nats-server binary is available
   */
  private async checkNatsServerAvailable(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = spawn('which', ['nats-server']);

      check.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              'nats-server not found in PATH. Install with: brew install nats-server'
            )
          );
        }
      });

      check.on('error', () => {
        reject(
          new Error(
            'nats-server not found in PATH. Install with: brew install nats-server'
          )
        );
      });
    });
  }

  /**
   * Build command line arguments for nats-server
   */
  private buildArgs(options: EmbeddedServerOptions): string[] {
    const args: string[] = [];

    // Port
    args.push('--port', String(options.port ?? 4222));

    // HTTP monitoring port
    args.push('--http_port', String(options.httpPort ?? 8222));

    // Log level
    const logLevel = options.logLevel ?? 'info';
    if (logLevel === 'debug') {
      args.push('-D'); // Debug
    } else if (logLevel === 'info') {
      args.push('-V'); // Verbose
    }

    // JetStream (if enabled)
    if (options.jetstream?.enabled) {
      args.push('--jetstream');
      if (options.jetstream.storeDir) {
        args.push('--store_dir', options.jetstream.storeDir);
      }
    }

    return args;
  }

  /**
   * Wait for NATS server to be ready
   */
  private async waitForReady(port: number, timeoutMs = 5000): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false; // Prevent multiple resolve/reject calls

      const checkReady = (): void => {
        if (settled) {
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          settled = true;
          const logs = this.logs.join('\n');
          reject(
            new Error(
              `NATS server did not start within ${timeoutMs}ms. Logs:\n${logs}`
            )
          );
          return;
        }

        // Check if process is still running
        if (!this.process || this.process.exitCode !== null) {
          settled = true;
          const logs = this.logs.join('\n');
          const exitCode = this.process?.exitCode ?? 'unknown';
          reject(
            new Error(
              `NATS server process exited prematurely (exit code: ${exitCode}). Logs:\n${logs}`
            )
          );
          return;
        }

        // Check logs for ready message
        const hasReadyMessage = this.logs.some(
          (log) =>
            log.includes('Server is ready') ||
            log.includes('Listening for client connections')
        );

        if (hasReadyMessage) {
          settled = true;
          resolve();
          return;
        }

        // Continue checking
        setTimeout(checkReady, 100);
      };

      // Start checking after a short delay
      setTimeout(checkReady, 500);
    });
  }
}
