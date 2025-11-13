/**
 * Test helper to mock ModelScanner for integration tests
 *
 * This allows workers to report having a "test-model" without needing actual MLX model files.
 * Use this in integration tests where you need workers to accept requests for testing
 * routing, retry, timeout, and circuit breaker behaviors.
 */

export interface MockModelInfo {
  path: string;
  size: number;
  quantization?: string;
}

/**
 * Mock model scanner that reports having a test model
 */
export class MockModelScanner {
  private modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  /**
   * Returns a mocked scan result with test-model
   */
  async scan(): Promise<{
    models: Map<string, MockModelInfo>;
    totalSize: number;
  }> {
    const models = new Map<string, MockModelInfo>();

    // Always report having "test-model" for integration tests
    models.set('test-model', {
      path: `${this.modelDir}/test-model`,
      size: 1024 * 1024, // 1MB
      quantization: '4bit'
    });

    return {
      models,
      totalSize: 1024 * 1024
    };
  }

  /**
   * Mock method for compatibility
   */
  getModels(): Map<string, MockModelInfo> {
    const models = new Map<string, MockModelInfo>();
    models.set('test-model', {
      path: `${this.modelDir}/test-model`,
      size: 1024 * 1024,
      quantization: '4bit'
    });
    return models;
  }
}

/**
 * Create a mock that makes WorkerNode report having test-model capability
 *
 * Usage in tests:
 * ```typescript
 * import { createMockWorkerWithModel } from '@/tests/helpers/test-model-mock';
 *
 * const worker = createMockWorkerWithModel(config);
 * await worker.start(); // Will report having 'test-model'
 * ```
 */
export function createMockModelScanner(modelDir: string = 'mock'): MockModelScanner {
  return new MockModelScanner(modelDir);
}
