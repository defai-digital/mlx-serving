# Testing Guide for mlx-serving

> **Version**: v0.2.0-beta.1
> **Last Updated**: 2025-11-04
> **Status**: Production-Ready Testing Infrastructure

This guide explains the testing strategy, architecture, and best practices for mlx-serving. Our test suite ensures reliability, performance, and security for the MLX LLM serving engine.

---

## Table of Contents

1. [Overview](#overview)
2. [Test Architecture](#test-architecture)
3. [Running Tests](#running-tests)
4. [Writing Tests](#writing-tests)
5. [Test Conventions](#test-conventions)
6. [Coverage Requirements](#coverage-requirements)
7. [Troubleshooting](#troubleshooting)
8. [Best Practices](#best-practices)
9. [Examples](#examples)

---

## Overview

### Testing Philosophy

mlx-serving follows a **pragmatic testing approach**:

- **Target Coverage**: 80%+ (currently **87.2%**)
- **Test Quality > Test Quantity**: Meaningful tests that catch real bugs
- **Fast Feedback**: Test suite completes in ~19 seconds
- **Three-Layer Testing**: Unit, Integration, Security
- **Production Parity**: Tests mirror real-world usage patterns

### Current Test Status

```
Test Files:  33 passed, 1 failed (34)  → 97.1% pass rate
Tests:       360 passed, 8 failed (368) → 97.8% pass rate
Coverage:    87.2% (exceeds 80% target)
Duration:    ~19 seconds
```

### Test Types

| Type | Purpose | Count | Pass Rate |
|------|---------|-------|-----------|
| **Unit** | Test individual components in isolation | ~240 | 99%+ |
| **Integration** | Test component interactions | ~70 | 97%+ |
| **Security** | Validate security fixes (CVEs) | 46 | 100%* |

*Security tests may be skipped if Python 3.14+ is detected (MLX requires Python 3.8-3.12)

---

## Test Architecture

### Directory Structure

```
tests/
├── unit/                    # Unit tests (~240 tests)
│   ├── api/                 # Engine API layer tests
│   │   └── engine.test.ts   # Engine class tests
│   ├── core/                # Core services tests
│   │   ├── model-manager.test.ts
│   │   ├── generator-factory.test.ts
│   │   ├── request-queue.test.ts
│   │   └── model-artifact-cache.test.ts
│   ├── bridge/              # Python bridge tests
│   │   ├── python-runner.test.ts
│   │   ├── jsonrpc-transport.test.ts
│   │   ├── stream-registry.test.ts
│   │   ├── stream-registry-phase4.test.ts
│   │   └── ops-multiplexer*.test.ts
│   ├── config/              # Configuration tests
│   │   └── loader.test.ts   # Config loading/validation
│   ├── telemetry/           # Telemetry tests
│   │   ├── otel.test.ts     # OpenTelemetry metrics
│   │   └── bridge.test.ts   # Telemetry integration
│   └── utils/               # Utility function tests
│       ├── retry.test.ts
│       └── circuit-breaker.test.ts
│
├── integration/             # Integration tests (~70 tests)
│   ├── bridge.test.ts       # Full bridge integration
│   ├── model-caching.test.ts
│   ├── outlines/            # Structured generation tests
│   │   ├── json-schema.test.ts
│   │   └── xml-mode.test.ts
│   ├── vision/              # Vision model tests
│   │   ├── image-encoding.test.ts
│   │   ├── vision-model-loading.test.ts
│   │   └── vision-generation.test.ts
│   └── telemetry/
│       └── engine-integration.test.ts
│
├── security/                # Security tests (46 tests)
│   ├── path-traversal.test.ts     # CVE-2025-0001, CVE-2025-0002
│   ├── information-leakage.test.ts # CVE-2025-0003
│   └── buffer-overflow.test.ts     # CVE-2025-0004
│
└── fixtures/                # Test fixtures and mocks
    ├── mock-responses.ts
    └── test-models.ts
```

### Test Framework Stack

- **Test Runner**: [Vitest](https://vitest.dev/) - Fast, modern testing framework
- **Coverage**: c8 (V8's built-in coverage)
- **Mocking**: Vitest mocking utilities (`vi.mock()`)
- **Assertions**: Expect API (Jest-compatible)
- **Type Safety**: Full TypeScript support

### Configuration

**File**: `vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'c8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**'],
      thresholds: {
        lines: 80,      // 80% line coverage required
        functions: 80,  // 80% function coverage required
        branches: 75,   // 75% branch coverage required
        statements: 80, // 80% statement coverage required
      },
    },
  },
});
```

---

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm test:watch

# Run tests with coverage report
npm test:coverage

# Run specific test file
npm test tests/unit/api/engine.test.ts

# Run tests matching a pattern
npm test -- -t "ModelManager"

# Run tests with verbose output
npm test -- --reporter=verbose
```

### Filtering Tests

```bash
# Run only unit tests
npm test tests/unit/

# Run only integration tests
npm test tests/integration/

# Run only security tests
npm test tests/security/

# Run specific test suite
npm test -- -t "Circuit Breaker"

# Run tests in a specific file
npm test tests/unit/utils/retry.test.ts
```

### CI/CD Integration

**GitHub Actions Workflow** (`.github/workflows/ci.yml`):

```yaml
- name: Run tests
  run: npm test

- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/coverage-final.json
```

The CI pipeline runs:
1. Lint (`npm lint`)
2. Type check (`npm typecheck`)
3. Unit tests
4. Integration tests
5. Security tests (if Python 3.11/3.12 available)
6. Coverage report

---

## Writing Tests

### Unit Test Pattern

**File**: `tests/unit/core/model-manager.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelManager } from '@core/model-manager.js';
import type { PythonBridge } from '@bridge/python-runner.js';

describe('ModelManager', () => {
  let manager: ModelManager;
  let mockBridge: PythonBridge;

  beforeEach(() => {
    // Setup: Create mocks and instances
    mockBridge = {
      request: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as PythonBridge;

    manager = new ModelManager(mockBridge);
  });

  afterEach(() => {
    // Cleanup: Reset mocks
    vi.clearAllMocks();
  });

  describe('loadModel', () => {
    it('should load a model successfully', async () => {
      // Arrange
      const modelId = 'test-model';
      mockBridge.request.mockResolvedValue({
        handle: 'model-123',
        model_id: modelId,
      });

      // Act
      const handle = await manager.loadModel({ model: modelId });

      // Assert
      expect(handle).toMatchObject({
        model: modelId,
        handle: 'model-123',
      });
      expect(mockBridge.request).toHaveBeenCalledWith(
        'load_model',
        expect.objectContaining({ model_id: modelId })
      );
    });

    it('should throw error for invalid model', async () => {
      // Arrange
      mockBridge.request.mockRejectedValue(
        new Error('Model not found')
      );

      // Act & Assert
      await expect(
        manager.loadModel({ model: 'invalid-model' })
      ).rejects.toThrow('Model not found');
    });
  });
});
```

### Integration Test Pattern

**File**: `tests/integration/bridge.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index.js';
import type { Engine } from '@types/engine.js';

describe('Bridge Integration', () => {
  let engine: Engine;

  beforeAll(async () => {
    // Setup: Start real Python runtime
    engine = await createEngine({ verbose: false });
  }, 30000); // 30s timeout for Python startup

  afterAll(async () => {
    // Cleanup: Shutdown Python runtime
    await engine.shutdown();
  });

  it('should load and unload model', async () => {
    // Arrange
    const modelId = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

    // Act: Load model
    const handle = await engine.loadModel({ model: modelId });
    expect(handle.model).toBe(modelId);

    // Act: Unload model
    await engine.unloadModel(handle);

    // Assert: Model should be unloaded
    const models = await engine.listModels();
    expect(models).not.toContain(handle);
  }, 60000); // 60s timeout for model loading
});
```

### Security Test Pattern

**File**: `tests/security/path-traversal.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index.js';
import type { Engine } from '@types/engine.js';

describe('Security: Path Traversal (CVE-2025-0001)', () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await createEngine({ verbose: false });
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  it('should reject path traversal in model_id', async () => {
    // Arrange: Malicious model ID with path traversal
    const maliciousId = '../../../etc/passwd';

    // Act & Assert: Should throw validation error
    await expect(
      engine.loadModel({ model: maliciousId })
    ).rejects.toThrow(/Invalid model_id/);
  });

  it('should reject absolute path in model_id', async () => {
    // Arrange: Absolute path
    const absolutePath = '/etc/passwd';

    // Act & Assert: Should throw validation error
    await expect(
      engine.loadModel({ model: absolutePath })
    ).rejects.toThrow(/Invalid model_id/);
  });
});
```

### Async Generator Testing

**Testing streaming with createGenerator()**:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index.js';

describe('Generator Streaming', () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await createEngine();
    await engine.loadModel({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    });
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  it('should stream tokens', async () => {
    // Arrange
    const chunks: string[] = [];
    const prompt = 'Count to 5:';

    // Act: Collect all chunks from generator
    for await (const chunk of engine.createGenerator({
      model: 'llama',
      prompt,
      maxTokens: 20,
    })) {
      chunks.push(chunk.text);
    }

    // Assert
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('1');
  }, 30000);

  it('should support cancellation via AbortSignal', async () => {
    // Arrange
    const controller = new AbortController();
    const chunks: string[] = [];

    // Act: Start generator and cancel after 2 chunks
    try {
      let count = 0;
      for await (const chunk of engine.createGenerator({
        model: 'llama',
        prompt: 'Write a long story',
        maxTokens: 100,
        signal: controller.signal,
      })) {
        chunks.push(chunk.text);
        count++;
        if (count >= 2) {
          controller.abort();
        }
      }
    } catch (error) {
      // Expected: AbortError
      expect(error.name).toBe('AbortError');
    }

    // Assert
    expect(chunks.length).toBe(2);
  });
});
```

---

## Test Conventions

### File Naming

- **Unit tests**: `*.test.ts` (co-located with source or in `tests/unit/`)
- **Integration tests**: `*.test.ts` in `tests/integration/`
- **Security tests**: `*.test.ts` in `tests/security/`

### Test Structure

Use the **Arrange-Act-Assert** pattern:

```typescript
it('should do something', () => {
  // Arrange: Setup test data and mocks
  const input = 'test';
  const expected = 'TEST';

  // Act: Execute the code under test
  const result = transform(input);

  // Assert: Verify the result
  expect(result).toBe(expected);
});
```

### Describe Blocks

Organize tests hierarchically:

```typescript
describe('ModelManager', () => {
  describe('loadModel', () => {
    it('should load model with default options', () => {});
    it('should load model with quantization', () => {});
    it('should throw error for invalid model', () => {});
  });

  describe('unloadModel', () => {
    it('should unload model successfully', () => {});
    it('should handle double unload gracefully', () => {});
  });
});
```

### Setup and Teardown

```typescript
describe('MyComponent', () => {
  let component: MyComponent;

  // Runs once before all tests in this describe block
  beforeAll(() => {
    // Expensive setup (e.g., start database)
  });

  // Runs before each test
  beforeEach(() => {
    component = new MyComponent();
  });

  // Runs after each test
  afterEach(() => {
    component.cleanup();
    vi.clearAllMocks();
  });

  // Runs once after all tests in this describe block
  afterAll(() => {
    // Expensive cleanup (e.g., stop database)
  });
});
```

### Timeouts

Set custom timeouts for slow tests:

```typescript
it('should load large model', async () => {
  // Test code
}, 60000); // 60 second timeout
```

Default timeout: 5 seconds

### Mocking

**Mock modules**:

```typescript
import { vi } from 'vitest';
import { PythonRunner } from '@bridge/python-runner.js';

// Mock the entire module
vi.mock('@bridge/python-runner.js', () => ({
  PythonRunner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(),
  })),
}));
```

**Mock functions**:

```typescript
const mockFn = vi.fn();
mockFn.mockReturnValue(42);
mockFn.mockResolvedValue({ success: true });
mockFn.mockRejectedValue(new Error('Failed'));
```

**Spy on methods**:

```typescript
const spy = vi.spyOn(obj, 'method');
spy.mockImplementation(() => 'mocked');
```

---

## Coverage Requirements

### Current Coverage

```
Coverage:    87.2% overall
Lines:       87.2%
Functions:   87.2%+
Branches:    85%+
Statements:  87.2%
```

### Target Coverage

| Metric | Threshold | Current | Status |
|--------|-----------|---------|--------|
| **Lines** | 80% | 87.2% | ✅ **EXCEEDS** |
| **Functions** | 80% | 87.2%+ | ✅ **EXCEEDS** |
| **Branches** | 75% | 85%+ | ✅ **EXCEEDS** |
| **Statements** | 80% | 87.2% | ✅ **EXCEEDS** |

**Philosophy**: 80%+ coverage with meaningful tests is better than 100% coverage with shallow tests.

### Coverage by Layer

| Layer | Coverage | Notes |
|-------|----------|-------|
| **API** (`src/api/`) | 90%+ | High coverage, user-facing |
| **Core** (`src/core/`) | 90%+ | High coverage, critical paths |
| **Bridge** (`src/bridge/`) | 85%+ | Good coverage, complex IPC |
| **Utils** (`src/utils/`) | 95%+ | Excellent coverage, utility fns |
| **Types** (`src/types/`) | N/A | Type-only, no runtime code |

### Generating Coverage Reports

```bash
# Run tests with coverage
npm test:coverage

# Open HTML coverage report
open coverage/index.html
```

Coverage report locations:
- **Text**: Console output
- **JSON**: `coverage/coverage-final.json`
- **HTML**: `coverage/index.html`

---

## Troubleshooting

### Common Issues

#### 1. Tests Timing Out

**Symptom**: Test hangs for 5+ seconds and fails with timeout error.

**Causes**:
- Async operation not awaited
- Promise not resolved
- Infinite loop
- Python runtime not responding

**Solutions**:

```typescript
// ❌ Bad: Missing await
it('should load model', () => {
  engine.loadModel({ model: 'llama' }); // Not awaited!
  expect(true).toBe(true);
});

// ✅ Good: Properly awaited
it('should load model', async () => {
  await engine.loadModel({ model: 'llama' });
  expect(true).toBe(true);
});

// ✅ Good: Increase timeout for slow operations
it('should load large model', async () => {
  await engine.loadModel({ model: 'llama-70b' });
}, 60000); // 60s timeout
```

#### 2. Python Environment Issues

**Symptom**: Integration/security tests fail with "Python runtime failed to start".

**Cause**: Python 3.14+ detected (MLX requires Python 3.8-3.12).

**Solution**:

```bash
# Check Python version
python3 --version

# Install compatible Python version (macOS with Homebrew)
brew install python@3.11

# Recreate virtual environment with correct Python
rm -rf .kr-mlx-venv/
npm run prepare:python

# Verify MLX installation
.kr-mlx-venv/bin/python -c "import mlx; print(mlx.__version__)"
```

#### 3. Mocking Issues

**Symptom**: Test fails because mock is not called correctly.

**Common mistakes**:

```typescript
// ❌ Bad: Mock after import
import { myFunction } from './module';
vi.mock('./module'); // Too late!

// ✅ Good: Mock before import
vi.mock('./module');
import { myFunction } from './module';

// ❌ Bad: Forgetting to reset mocks
it('test 1', () => {
  mockFn.mockReturnValue(1);
});
it('test 2', () => {
  // mockFn still returns 1 from previous test!
});

// ✅ Good: Reset in afterEach
afterEach(() => {
  vi.clearAllMocks();
});
```

#### 4. Flaky Tests

**Symptom**: Test passes/fails intermittently.

**Causes**:
- Race conditions
- Timing dependencies
- Shared state between tests
- Non-deterministic behavior

**Solutions**:

```typescript
// ❌ Bad: Timing-dependent
it('should receive event', async () => {
  emitter.emit('event');
  await wait(100); // Flaky timing
  expect(received).toBe(true);
});

// ✅ Good: Event-driven
it('should receive event', async () => {
  const promise = new Promise((resolve) => {
    emitter.once('event', resolve);
  });
  emitter.emit('event');
  await promise; // Deterministic
});

// ❌ Bad: Shared state
let sharedState = 0;
it('test 1', () => { sharedState++; });
it('test 2', () => { expect(sharedState).toBe(0); }); // Fails!

// ✅ Good: Isolated state
beforeEach(() => {
  sharedState = 0; // Reset before each test
});
```

#### 5. Coverage Not Updating

**Symptom**: Coverage report shows old numbers after adding tests.

**Solutions**:

```bash
# Clear coverage cache
rm -rf coverage/

# Run tests with fresh coverage
npm test:coverage

# If using vitest watch mode, press 'c' to clear cache
```

---

## Best Practices

### 1. Test Isolation

**Each test should be independent and not rely on other tests**.

```typescript
// ❌ Bad: Tests depend on execution order
it('should create user', () => {
  userId = createUser(); // Shared state
});
it('should delete user', () => {
  deleteUser(userId); // Depends on previous test
});

// ✅ Good: Each test is self-contained
describe('User management', () => {
  let userId: string;

  beforeEach(() => {
    userId = createUser(); // Fresh state for each test
  });

  afterEach(() => {
    deleteUser(userId); // Clean up after each test
  });

  it('should create user', () => {
    expect(userId).toBeDefined();
  });

  it('should delete user', () => {
    expect(deleteUser(userId)).toBe(true);
  });
});
```

### 2. Descriptive Test Names

**Test names should describe what is being tested and the expected behavior**.

```typescript
// ❌ Bad: Vague test names
it('works', () => {});
it('test 1', () => {});
it('model', () => {});

// ✅ Good: Descriptive test names
it('should load model successfully', () => {});
it('should throw error for invalid model', () => {});
it('should cache model after first load', () => {});
```

### 3. Arrange-Act-Assert (AAA)

**Structure tests with clear sections**:

```typescript
it('should calculate total price', () => {
  // Arrange: Setup test data
  const items = [
    { price: 10, quantity: 2 },
    { price: 5, quantity: 3 },
  ];

  // Act: Execute code under test
  const total = calculateTotal(items);

  // Assert: Verify result
  expect(total).toBe(35);
});
```

### 4. Test Edge Cases

**Don't just test the happy path**.

```typescript
describe('divide', () => {
  it('should divide positive numbers', () => {
    expect(divide(10, 2)).toBe(5);
  });

  it('should divide negative numbers', () => {
    expect(divide(-10, 2)).toBe(-5);
  });

  it('should handle zero numerator', () => {
    expect(divide(0, 5)).toBe(0);
  });

  it('should throw error for zero denominator', () => {
    expect(() => divide(10, 0)).toThrow('Division by zero');
  });

  it('should handle decimal results', () => {
    expect(divide(10, 3)).toBeCloseTo(3.333, 3);
  });
});
```

### 5. Use Meaningful Assertions

**Choose the right assertion for the job**.

```typescript
// ❌ Bad: Too loose
expect(result).toBeTruthy();

// ✅ Good: Specific assertion
expect(result).toBe(42);

// ❌ Bad: Hard to debug
expect(JSON.stringify(obj)).toBe(JSON.stringify(expected));

// ✅ Good: Object comparison
expect(obj).toEqual(expected);

// ✅ Good: Partial object matching
expect(obj).toMatchObject({ id: 123, name: 'Test' });

// ✅ Good: Array contains
expect(array).toContain('item');
expect(array).toContainEqual({ id: 1 });

// ✅ Good: Error assertions
expect(() => fn()).toThrow();
expect(() => fn()).toThrow('Expected error message');
expect(() => fn()).toThrow(CustomError);

// ✅ Good: Async assertions
await expect(promise).resolves.toBe(42);
await expect(promise).rejects.toThrow('Error');
```

### 6. Mock Strategically

**Mock external dependencies, not internal logic**.

```typescript
// ✅ Good: Mock external HTTP client
vi.mock('axios');
import axios from 'axios';
axios.get.mockResolvedValue({ data: { /* ... */ } });

// ✅ Good: Mock Python bridge (external process)
const mockBridge = {
  request: vi.fn().mockResolvedValue({ success: true }),
};

// ❌ Bad: Mocking everything defeats the purpose of the test
vi.mock('@core/model-manager.js');
vi.mock('@bridge/stream-registry.js');
vi.mock('@utils/logger.js');
// ... now you're just testing mocks, not real code!
```

---

## Examples

### Example 1: Basic Unit Test

**Test a utility function**:

```typescript
// src/utils/format.ts
export function formatModelId(id: string): string {
  return id.replace(/\//g, '-');
}

// tests/unit/utils/format.test.ts
import { describe, it, expect } from 'vitest';
import { formatModelId } from '@utils/format.js';

describe('formatModelId', () => {
  it('should replace slashes with dashes', () => {
    expect(formatModelId('org/model')).toBe('org-model');
  });

  it('should handle multiple slashes', () => {
    expect(formatModelId('org/repo/model')).toBe('org-repo-model');
  });

  it('should return unchanged if no slashes', () => {
    expect(formatModelId('model')).toBe('model');
  });

  it('should handle empty string', () => {
    expect(formatModelId('')).toBe('');
  });
});
```

### Example 2: Integration Test with Python Runtime

**Test the full stack**:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index.js';
import type { Engine } from '@types/engine.js';

describe('End-to-End Generation', () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await createEngine({ verbose: false });
    await engine.loadModel({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    });
  }, 60000);

  afterAll(async () => {
    await engine.shutdown();
  });

  it('should generate text from prompt', async () => {
    // Arrange
    const prompt = 'The capital of France is';

    // Act: Collect all generated tokens
    const tokens: string[] = [];
    for await (const chunk of engine.createGenerator({
      model: 'llama',
      prompt,
      maxTokens: 10,
      temperature: 0.0, // Deterministic
    })) {
      tokens.push(chunk.text);
    }

    // Assert
    const generated = tokens.join('');
    expect(generated.toLowerCase()).toContain('paris');
  }, 30000);
});
```

### Example 3: Security Test

**Test path traversal prevention**:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index.js';

describe('Security: Path Traversal', () => {
  let engine;

  beforeAll(async () => {
    engine = await createEngine();
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  const maliciousPaths = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'model/../../secret',
  ];

  maliciousPaths.forEach((path) => {
    it(`should reject malicious path: ${path}`, async () => {
      await expect(
        engine.loadModel({ model: path })
      ).rejects.toThrow(/Invalid model_id/);
    });
  });
});
```

### Example 4: Testing Error Handling

**Test retry logic**:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff } from '@utils/retry.js';

describe('retryWithBackoff', () => {
  it('should succeed on first attempt', async () => {
    // Arrange
    const fn = vi.fn().mockResolvedValue('success');

    // Act
    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelay: 100,
    });

    // Assert
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    // Arrange
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValue('success');

    // Act
    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelay: 10,
    });

    // Assert
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts', async () => {
    // Arrange
    const fn = vi.fn().mockRejectedValue(new Error('Always fails'));

    // Act & Assert
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelay: 10,
      })
    ).rejects.toThrow('Always fails');

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

### Example 5: Testing Async Generators

**Test streaming behavior**:

```typescript
import { describe, it, expect } from 'vitest';

async function* generateNumbers(count: number) {
  for (let i = 0; i < count; i++) {
    yield i;
  }
}

describe('Async Generator', () => {
  it('should generate sequence of numbers', async () => {
    // Arrange
    const expected = [0, 1, 2, 3, 4];
    const actual: number[] = [];

    // Act
    for await (const num of generateNumbers(5)) {
      actual.push(num);
    }

    // Assert
    expect(actual).toEqual(expected);
  });

  it('should support early termination', async () => {
    // Arrange
    const actual: number[] = [];

    // Act
    for await (const num of generateNumbers(10)) {
      actual.push(num);
      if (num >= 2) break; // Early termination
    }

    // Assert
    expect(actual).toEqual([0, 1, 2]);
  });
});
```

---

## Summary

### Key Takeaways

1. **Target 80%+ coverage** with meaningful tests
2. **Three test layers**: Unit, Integration, Security
3. **Fast feedback**: Test suite completes in ~19 seconds
4. **Isolation**: Each test is independent
5. **Descriptive**: Test names describe behavior
6. **Arrange-Act-Assert**: Structure tests clearly
7. **Mock strategically**: External dependencies, not internal logic
8. **Test edge cases**: Don't just test happy paths

### Quick Reference

```bash
# Run all tests
npm test

# Run with coverage
npm test:coverage

# Run specific tests
npm test tests/unit/api/

# Watch mode
npm test:watch

# Type check
npm typecheck

# Lint
npm lint
```

### Resources

- **Test Framework**: [Vitest Documentation](https://vitest.dev/)
- **Assertions**: [Expect API Reference](https://vitest.dev/api/expect.html)
- **Mocking**: [Vitest Mocking Guide](https://vitest.dev/guide/mocking.html)
- **Coverage**: [c8 Documentation](https://github.com/bcoe/c8)

---

**Need Help?**

- Check the [troubleshooting section](#troubleshooting)
- Review existing tests in `tests/` for patterns
- See `vitest.config.ts` for configuration
- Ask in GitHub Issues: https://github.com/defai-digital/mlx-serving/issues

---

**Version**: v0.2.0-beta.1
**Last Updated**: 2025-11-04
**Status**: Production-Ready Testing Infrastructure
