/**
 * API Server
 *
 * REST API server with Express.js providing OpenAI-compatible endpoints
 * and cluster management endpoints.
 */

import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import type { Server } from 'http';
import type { ControllerNode } from './controller-node.js';
import type { ClusterConfig } from '../types/config.js';
import type { InferenceRequest } from '../types/messages.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

/**
 * OpenAI chat completions request format
 */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

/**
 * API Server
 *
 * Provides HTTP REST API with:
 * - POST /v1/chat/completions (OpenAI-compatible)
 * - GET /api/cluster/status
 * - GET /api/cluster/workers
 * - GET /api/cluster/workers/:id
 * - GET /health
 *
 * @example
 * ```typescript
 * const server = new ApiServer(controller, config);
 * await server.start();
 * ```
 */
export class ApiServer {
  private app: Application;
  private server?: Server;
  private controller: ControllerNode;
  private config: ClusterConfig;
  private logger: Logger;

  constructor(controller: ControllerNode, config: ClusterConfig) {
    this.controller = controller;
    this.config = config;
    this.logger = createLogger('ApiServer');

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS
    this.app.use(
      cors({
        origin: '*', // TODO: Make configurable from config
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      })
    );

    // JSON body parser
    this.app.use(express.json());

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.logger.debug('HTTP request', {
        method: req.method,
        path: req.path,
        query: req.query,
      });
      next();
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', this.handleHealth.bind(this));

    // OpenAI-compatible chat completions
    this.app.post('/v1/chat/completions', this.handleChatCompletions.bind(this));

    // Cluster status
    this.app.get('/api/cluster/status', this.handleClusterStatus.bind(this));

    // Workers list
    this.app.get('/api/cluster/workers', this.handleWorkersList.bind(this));

    // Worker details
    this.app.get('/api/cluster/workers/:id', this.handleWorkerDetails.bind(this));
  }

  /**
   * Setup error handling middleware
   */
  private setupErrorHandling(): void {
    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    // Global error handler
    this.app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      this.logger.error('API error', err, {
        method: req.method,
        path: req.path,
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
      });
    });
  }

  /**
   * Handle health check
   */
  private handleHealth(req: Request, res: Response): void {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
    });
  }

  /**
   * Handle chat completions (OpenAI-compatible)
   */
  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    try {
      // Validate request body
      const body = req.body as ChatCompletionRequest;

      if (!body.model) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing required field: model',
        });
        return;
      }

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing or invalid field: messages',
        });
        return;
      }

      // Convert messages to prompt (simple concatenation)
      const prompt = body.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');

      if (!prompt) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'No user messages found',
        });
        return;
      }

      // Create inference request
      const inferenceRequest: InferenceRequest = {
        requestId: randomUUID(),
        modelId: body.model,
        prompt,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
      };

      this.logger.info('Chat completion request', {
        requestId: inferenceRequest.requestId,
        model: body.model,
        promptLength: prompt.length,
        stream: body.stream ?? false,
      });

      // Route to worker
      const stream = await this.controller.handleInferenceRequest(inferenceRequest);

      // Handle streaming vs non-streaming
      if (body.stream) {
        await this.streamResponse(res, stream, inferenceRequest.requestId);
      } else {
        await this.bufferedResponse(res, stream, inferenceRequest.requestId);
      }
    } catch (error) {
      this.logger.error('Chat completion failed', error as Error);

      if ((error as Error).message.includes('No workers')) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: (error as Error).message,
        });
      } else {
        res.status(500).json({
          error: 'Internal Server Error',
          message: (error as Error).message,
        });
      }
    }
  }

  /**
   * Stream response using Server-Sent Events (SSE)
   */
  private async streamResponse(
    res: Response,
    stream: ReadableStream,
    requestId: string
  ): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = stream.getReader();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Send [DONE] marker
          res.write('data: [DONE]\n\n');
          res.end();
          break;
        }

        // Send token as SSE
        const data = JSON.stringify({
          choices: [
            {
              delta: {
                content: value,
              },
            },
          ],
        });

        res.write(`data: ${data}\n\n`);

        // Flush immediately
        if ('flush' in res && typeof res.flush === 'function') {
          res.flush();
        }
      }
    } catch (error) {
      this.logger.error('Streaming error', error as Error, { requestId });
      res.end();
    }
  }

  /**
   * Buffer full response and send as JSON
   */
  private async bufferedResponse(
    res: Response,
    stream: ReadableStream,
    requestId: string
  ): Promise<void> {
    const reader = stream.getReader();
    const tokens: string[] = [];

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        tokens.push(value);
      }

      const content = tokens.join('');

      res.json({
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'unknown', // TODO: Track model
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0, // TODO: Track usage
          completion_tokens: tokens.length,
          total_tokens: tokens.length,
        },
      });
    } catch (error) {
      this.logger.error('Buffered response error', error as Error, { requestId });
      throw error;
    }
  }

  /**
   * Handle cluster status request
   */
  private handleClusterStatus(req: Request, res: Response): void {
    const status = this.controller.getClusterStatus();
    res.json(status);
  }

  /**
   * Handle workers list request
   */
  private handleWorkersList(req: Request, res: Response): void {
    const workers = this.controller.getAllWorkers();
    res.json(workers);
  }

  /**
   * Handle worker details request
   */
  private handleWorkerDetails(req: Request, res: Response): void {
    const workerId = req.params.id;

    if (!workerId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing worker ID',
      });
      return;
    }

    const worker = this.controller.getWorker(workerId);

    if (!worker) {
      res.status(404).json({
        error: 'Not Found',
        message: `Worker ${workerId} not found`,
      });
      return;
    }

    res.json(worker);
  }

  /**
   * Start API server
   */
  async start(): Promise<void> {
    const port = this.config.controller?.port ?? 8080;
    const bindAddress = this.config.controller?.bindAddress ?? '0.0.0.0';

    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, bindAddress, () => {
          this.logger.info('API server started', {
            port,
            bindAddress,
            endpoints: [
              `POST http://${bindAddress === '0.0.0.0' ? 'localhost' : bindAddress}:${port}/v1/chat/completions`,
              `GET http://${bindAddress === '0.0.0.0' ? 'localhost' : bindAddress}:${port}/api/cluster/status`,
              `GET http://${bindAddress === '0.0.0.0' ? 'localhost' : bindAddress}:${port}/api/cluster/workers`,
              `GET http://${bindAddress === '0.0.0.0' ? 'localhost' : bindAddress}:${port}/health`,
            ],
          });
          resolve();
        });

        this.server.on('error', (error) => {
          this.logger.error('Server error', error);
          reject(error);
        });
      } catch (error) {
        this.logger.error('Failed to start server', error as Error);
        reject(error);
      }
    });
  }

  /**
   * Stop API server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      this.logger.warn('Server not running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          this.logger.error('Failed to stop server', error);
          reject(error);
        } else {
          this.logger.info('API server stopped');
          this.server = undefined;
          resolve();
        }
      });
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== undefined;
  }
}
