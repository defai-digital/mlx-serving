import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only include test files in tests/ directory
    include: ['tests/**/*.{test,spec}.ts'],
    // Exclude Python venv, node_modules, and other non-test directories
    exclude: [
      '**/node_modules/**',
      '**/.kr-mlx-venv/**',
      '**/dist/**',
      '**/.git/**',
      '**/models/**',
      '**/benchmarks/**',
    ],
    // Bug Fix #25: Disable file parallelism to prevent port collisions
    // Controller integration tests start NATS servers which need unique ports
    // Running in parallel causes "address already in use" errors
    fileParallelism: false,
    // Isolate tests with mocks to prevent interference
    poolOptions: {
      threads: {
        isolate: true,
        // Limit concurrent workers to prevent OOM errors
        maxThreads: 4,
        minThreads: 1,
      },
    },
    // Prevent memory leaks in long-running tests
    testTimeout: 30000, // 30 seconds default timeout
    hookTimeout: 30000, // 30 seconds for setup/teardown
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.spec.ts',
        '**/*.test.ts',
        'scripts/',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@core': path.resolve(__dirname, './src/core'),
      '@adapters': path.resolve(__dirname, './src/adapters'),
      '@api': path.resolve(__dirname, './src/api'),
      '@bridge': path.resolve(__dirname, './src/bridge'),
      '@types': path.resolve(__dirname, './src/types'),
      '@utils': path.resolve(__dirname, './src/utils'),
    },
  },
});
