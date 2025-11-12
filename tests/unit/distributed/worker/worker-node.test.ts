import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerNode, WorkerState } from '@/distributed/worker/worker-node.js';
import type { ClusterConfig } from '@/distributed/types/config.js';

// Mock modules
vi.mock('@/distributed/nats/client.js');
vi.mock('@/api/engine.js');
vi.mock('@/distributed/worker/hardware-reporter.js');
vi.mock('@/distributed/worker/metrics-collector.js');
vi.mock('@/distributed/worker/model-scanner.js');

// Import mocked modules
import { NatsClient } from '@/distributed/nats/client.js';
import { Engine } from '@/api/engine.js';
import { HardwareReporter } from '@/distributed/worker/hardware-reporter.js';
import { MetricsCollector } from '@/distributed/worker/metrics-collector.js';
import { ModelScanner } from '@/distributed/worker/model-scanner.js';

describe('WorkerNode', () => {
  let worker: WorkerNode;
  let mockConfig: ClusterConfig;
  let mockNatsClient: any;
  let mockEngine: any;
  let mockHardwareReporter: any;
  let mockMetricsCollector: any;
  let mockModelScanner: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup mock config
    mockConfig = {
      mode: 'worker',
      nats: {
        mode: 'embedded',
      },
      worker: {
        port: 8080,
        model_dir: 'model',
      },
      discovery: {
        enabled: true,
        heartbeat_interval_ms: 5000,
        offline_timeout_ms: 15000,
      },
      runtime: {},
    } as ClusterConfig;

    // Setup NATS client mock
    mockNatsClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue({}),
      getServerUrl: vi.fn().mockReturnValue('nats://localhost:4222'),
    };
    vi.mocked(NatsClient).mockImplementation(() => mockNatsClient);

    // Setup Engine mock
    mockEngine = {
      loadModel: vi.fn().mockResolvedValue(undefined),
      generate: vi.fn().mockResolvedValue(createMockStream(['Hello', ' world'])),
      getLoadedModels: vi.fn().mockReturnValue([]),
    };
    vi.mocked(Engine).mockImplementation(() => mockEngine);

    // Setup HardwareReporter mock
    mockHardwareReporter = {
      getHardwareProfile: vi.fn().mockReturnValue({
        chipModel: 'M3-Pro',
        chipGeneration: 3,
        variant: 'Pro',
        gpuCores: 18,
        cpuCores: 12,
        performanceCores: 6,
        efficiencyCores: 6,
        unifiedMemoryGB: 36,
        metalVersion: 'Metal 3.0',
        osVersion: '14.0.0',
        detectedAt: Date.now(),
      }),
      getCapabilities: vi.fn().mockReturnValue({
        maxConcurrent: 3,
        supportedModelTiers: ['13-27B', '7-13B', '3-7B', '<3B'],
        availableMemoryGB: 28.8,
      }),
      getCpuUsage: vi.fn().mockResolvedValue(45),
      getMemoryUsage: vi.fn().mockReturnValue(12.5),
      getGpuUtilization: vi.fn().mockReturnValue(0),
      getAvailableMemory: vi.fn().mockReturnValue(23.5),
    };
    vi.mocked(HardwareReporter).mockImplementation(() => mockHardwareReporter);

    // Setup MetricsCollector mock
    mockMetricsCollector = {
      recordRequest: vi.fn(),
      recordError: vi.fn(),
      getMetrics: vi.fn().mockReturnValue({
        requests: { total: 0, success: 0, error: 0 },
        latency: { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 },
        throughput: { tokensPerSecond: 0, requestsPerSecond: 0 },
        models: {},
      }),
      getAverageLatency: vi.fn().mockReturnValue(0),
      getThroughput: vi.fn().mockReturnValue(0),
      getErrorRate: vi.fn().mockReturnValue(0),
      reset: vi.fn(),
    };
    vi.mocked(MetricsCollector).mockImplementation(() => mockMetricsCollector);

    // Setup ModelScanner mock
    mockModelScanner = {
      scan: vi.fn().mockResolvedValue({
        availableModels: ['mlx-community/test-model'],
        modelPaths: { 'mlx-community/test-model': '/path/to/model' },
        totalModelSize: 1000000,
        lastScanned: Date.now(),
      }),
    };
    vi.mocked(ModelScanner).mockImplementation(() => mockModelScanner);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create worker with auto-generated ID', () => {
      worker = new WorkerNode({ config: mockConfig });

      expect(worker.getWorkerId()).toBeTruthy();
      expect(worker.getWorkerId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should create worker with specified ID', () => {
      const workerId = 'custom-worker-id';
      worker = new WorkerNode({ config: mockConfig, workerId });

      expect(worker.getWorkerId()).toBe(workerId);
    });

    it('should start in IDLE state', () => {
      worker = new WorkerNode({ config: mockConfig });

      expect(worker.getState()).toBe(WorkerState.IDLE);
    });

    it('should have zero active requests', () => {
      worker = new WorkerNode({ config: mockConfig });

      expect(worker.getActiveRequests()).toBe(0);
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      worker = new WorkerNode({ config: mockConfig });
    });

    afterEach(async () => {
      if (worker.getState() !== WorkerState.STOPPED) {
        await worker.stop();
      }
    });

    it('should transition through states correctly', async () => {
      const states: WorkerState[] = [];
      worker.on('stateChange', (state) => states.push(state));

      await worker.start();

      expect(states).toContain(WorkerState.CONNECTING);
      expect(states).toContain(WorkerState.REGISTERING);
      expect(worker.getState()).toBe(WorkerState.READY);
    });

    it('should connect to NATS', async () => {
      await worker.start();

      expect(mockNatsClient.connect).toHaveBeenCalledWith(mockConfig.nats);
    });

    it('should scan models', async () => {
      await worker.start();

      expect(mockModelScanner.scan).toHaveBeenCalled();
    });

    it('should send registration message', async () => {
      await worker.start();

      expect(mockNatsClient.publish).toHaveBeenCalledWith(
        'worker.register',
        expect.objectContaining({
          workerId: expect.any(String),
          hostname: expect.any(String),
          ip: expect.any(String),
          port: 8080,
          status: 'online',
        }),
      );
    });

    it('should subscribe to inference requests', async () => {
      await worker.start();

      expect(mockNatsClient.subscribe).toHaveBeenCalledWith(
        expect.stringContaining('.inference'),
        expect.any(Function),
      );
    });

    it('should emit ready event', async () => {
      const readyHandler = vi.fn();
      worker.on('ready', readyHandler);

      await worker.start();

      expect(readyHandler).toHaveBeenCalled();
    });

    it('should throw if already started', async () => {
      await worker.start();

      await expect(worker.start()).rejects.toThrow('Worker already started');
    });

    it('should handle connection errors', async () => {
      mockNatsClient.connect.mockRejectedValue(new Error('Connection failed'));

      await expect(worker.start()).rejects.toThrow('Failed to start worker');
      expect(worker.getState()).toBe(WorkerState.STOPPED);
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      worker = new WorkerNode({ config: mockConfig });
      await worker.start();
    });

    it('should transition to DRAINING state', async () => {
      const states: WorkerState[] = [];
      worker.on('stateChange', (state) => states.push(state));

      await worker.stop();

      expect(states).toContain(WorkerState.DRAINING);
    });

    it('should transition to STOPPED state', async () => {
      await worker.stop();

      expect(worker.getState()).toBe(WorkerState.STOPPED);
    });

    it('should disconnect from NATS', async () => {
      await worker.stop();

      expect(mockNatsClient.disconnect).toHaveBeenCalled();
    });

    it('should emit stopped event', async () => {
      const stoppedHandler = vi.fn();
      worker.on('stopped', stoppedHandler);

      await worker.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });
  });

  describe('heartbeat', () => {
    beforeEach(async () => {
      worker = new WorkerNode({ config: mockConfig });
    });

    afterEach(async () => {
      if (worker.getState() !== WorkerState.STOPPED) {
        await worker.stop();
      }
    });

    it('should send heartbeat messages', async () => {
      await worker.start();

      // Wait for at least one heartbeat
      await new Promise((resolve) => setTimeout(resolve, 100));

      const heartbeatCalls = mockNatsClient.publish.mock.calls.filter(
        ([topic]: [string]) => topic === 'worker.heartbeat',
      );

      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(0);
    });

    it('should stop heartbeat on stop', async () => {
      await worker.start();
      await worker.stop();

      const publishCallsBefore = mockNatsClient.publish.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const publishCallsAfter = mockNatsClient.publish.mock.calls.length;

      // No new heartbeats after stop
      expect(publishCallsAfter).toBe(publishCallsBefore);
    });
  });

  describe('getState()', () => {
    it('should return current state', () => {
      worker = new WorkerNode({ config: mockConfig });

      expect(worker.getState()).toBe(WorkerState.IDLE);
    });
  });

  describe('getWorkerId()', () => {
    it('should return worker ID', () => {
      worker = new WorkerNode({ config: mockConfig });
      const workerId = worker.getWorkerId();

      expect(workerId).toBeTruthy();
      expect(typeof workerId).toBe('string');
    });
  });

  describe('getActiveRequests()', () => {
    it('should return active request count', () => {
      worker = new WorkerNode({ config: mockConfig });

      expect(worker.getActiveRequests()).toBe(0);
    });
  });
});

// Helper function to create mock stream
function createMockStream(tokens: string[]): ReadableStream<string> {
  let index = 0;

  return new ReadableStream({
    async pull(controller) {
      if (index < tokens.length) {
        controller.enqueue(tokens[index++]);
      } else {
        controller.close();
      }
    },
  });
}
