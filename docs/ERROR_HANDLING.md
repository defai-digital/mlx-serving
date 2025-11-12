# Error Handling in mlx-serving

Production-grade error handling with automatic retries, circuit breakers, and comprehensive error types.

---

## Table of Contents

- [Overview](#overview)
- [Error Types](#error-types)
- [Retry Strategy](#retry-strategy)
- [Circuit Breaker](#circuit-breaker)
- [Configuration](#configuration)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)

---

## Overview

mlx-serving provides production-grade error handling to ensure reliability in distributed LLM serving environments:

### Key Features

- **Automatic Retries**: Transient failures are automatically retried with exponential backoff
- **Circuit Breaker**: Prevents cascading failures by stopping requests to failing services
- **Typed Errors**: Structured error types for programmatic handling
- **Error Recovery**: Automatic Python runtime restart and state reconciliation
- **Graceful Degradation**: Partial results returned when possible

### Architecture

```
┌─────────────────┐
│  Application    │
└────────┬────────┘
         │ try/catch
         ▼
┌─────────────────┐
│  Engine API     │ ← EngineClientError, TimeoutError
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Circuit        │ ← Opens after N failures
│  Breaker        │   Prevents cascading failures
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Retry Logic    │ ← Exponential backoff
└────────┬────────┘   Jitter to prevent thundering herd
         │
         ▼
┌─────────────────┐
│  JSON-RPC       │
│  Transport      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Python MLX     │
│  Runtime        │
└─────────────────┘
```

---

## Error Types

### EngineClientError

Base error class for all Engine API errors.

```typescript
class EngineClientError extends Error {
  code: EngineErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
```

### Error Codes

| Code | Description | Retryable |
|------|-------------|-----------|
| `ParseError` | Invalid JSON in request/response | ❌ |
| `InvalidRequest` | Malformed JSON-RPC request | ❌ |
| `MethodNotFound` | Unknown method called | ❌ |
| `InvalidParams` | Invalid parameters | ❌ |
| `InternalError` | Server internal error | ✅ |
| `ServerError` | Generic server error | ✅ |
| `ModelLoadError` | Model failed to load | ⚠️ (depends on cause) |
| `GenerationError` | Generation failed | ⚠️ (depends on cause) |
| `TokenizerError` | Tokenization failed | ❌ |
| `GuidanceError` | Structured output failed | ❌ |
| `ModelNotLoaded` | Model not in memory | ❌ |
| `RuntimeError` | Python runtime error | ✅ |
| `TransportError` | IPC communication error | ✅ |
| `Timeout` | Request timed out | ✅ |
| `Cancelled` | Operation cancelled by user | ❌ |
| `UnknownError` | Unclassified error | ⚠️ |

### TimeoutError

Extended error with timeout context:

```typescript
class TimeoutError extends EngineClientError {
  method: string;           // 'loadModel', 'generate', etc.
  timeout: number;          // Timeout value in ms
  requestId?: string;       // Request identifier
  duration?: number;        // Actual duration before timeout
}
```

### CircuitBreakerOpenError

Thrown when circuit breaker is open:

```typescript
class CircuitBreakerOpenError extends Error {
  code: number;             // -32000 (JSON-RPC ServerError)
  retryAfterMs: number;     // When to retry
  state: CircuitBreakerState;  // 'OPEN' | 'HALF_OPEN'
  circuit?: string;         // Circuit name
}
```

---

## Retry Strategy

### Overview

Transient failures are automatically retried with exponential backoff and jitter.

### Default Configuration

```yaml
# config/runtime.yaml
json_rpc:
  retry:
    max_attempts: 3              # Total attempts (initial + retries)
    initial_delay_ms: 100        # First retry after 100ms
    max_delay_ms: 5000           # Cap at 5 seconds
    backoff_multiplier: 2.0      # Exponential: 100ms → 200ms → 400ms
    jitter: 0.25                 # ±25% randomization
    retryable_errors:
      - TIMEOUT
      - ECONNRESET
```

### Retry Schedule Example

With default config (`initial_delay_ms: 100`, `backoff_multiplier: 2.0`, `jitter: 0.25`):

| Attempt | Base Delay | With Jitter | Total Time |
|---------|------------|-------------|------------|
| 1 (initial) | 0ms | 0ms | 0ms |
| 2 (retry 1) | 100ms | 75-125ms | 75-125ms |
| 3 (retry 2) | 200ms | 150-250ms | 225-375ms |
| 4 (retry 3) | 400ms | 300-500ms | 525-875ms |

### Jitter Benefits

- **Prevents Thundering Herd**: Randomization spreads retry load
- **Improves Success Rate**: Reduces retry collision probability
- **Configurable**: Set `jitter: 0` to disable

### Custom Retry Configuration

```typescript
import { retryWithBackoff } from '@defai.digital/mlx-serving/utils/retry.js';

const result = await retryWithBackoff(
  () => engine.tokenize({ model: 'llama', text: 'hello' }),
  {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 10000,
    backoffMultiplier: 2.5,
    retryableErrors: ['TIMEOUT', 'ECONNRESET', 'ETIMEDOUT'],
    jitter: 0.3,  // ±30% randomization
    onRetry: (context) => {
      console.log(`Retry ${context.attempt} after ${context.delayMs}ms`);
    },
  }
);
```

### Abort Signal Support

Cancel retry loop with AbortSignal:

```typescript
const controller = new AbortController();

setTimeout(() => controller.abort(), 5000); // Abort after 5s

try {
  await retryWithBackoff(
    () => engine.loadModel({ model: 'llama' }),
    {
      maxAttempts: 10,
      initialDelayMs: 100,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      retryableErrors: ['TIMEOUT'],
      signal: controller.signal,
    }
  );
} catch (error) {
  if (error.name === 'RetryAbortedError') {
    console.log('Retry loop aborted');
  }
}
```

---

## Circuit Breaker

### Overview

Circuit breaker pattern prevents cascading failures by stopping requests to failing services.

### States

```
CLOSED ────────────────┐ (Normal operation)
   ↓ (N failures)       │
OPEN ──────────────────┤ (Rejects all requests)
   ↓ (timeout)          │
HALF_OPEN ─────────────┘ (Testing recovery)
   ↓ (M successes)
CLOSED
```

**CLOSED**: Normal operation, requests flow through
**OPEN**: Service failing, all requests rejected immediately
**HALF_OPEN**: Testing if service recovered, limited probe requests allowed

### Default Configuration

```yaml
# config/runtime.yaml
json_rpc:
  circuit_breaker:
    failure_threshold: 5              # Open after 5 consecutive failures
    recovery_timeout_ms: 10000        # Stay open for 10 seconds
    half_open_max_calls: 1            # Allow 1 probe request in half-open
    half_open_success_threshold: 2    # Need 2 successes to close
    failure_window_ms: 60000          # Reset failure count after 60s inactivity
```

### State Transitions

1. **CLOSED → OPEN**: After `failure_threshold` consecutive failures
2. **OPEN → HALF_OPEN**: After `recovery_timeout_ms` elapsed
3. **HALF_OPEN → CLOSED**: After `half_open_success_threshold` successes
4. **HALF_OPEN → OPEN**: On any failure

### Custom Circuit Breaker

```typescript
import { CircuitBreaker } from '@defai.digital/mlx-serving/utils/circuit-breaker.js';

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  recoveryTimeoutMs: 5000,
  halfOpenMaxCalls: 1,
  halfOpenSuccessThreshold: 1,
  failureWindowMs: 30000,
  name: 'my-service',
  onStateChange: (event) => {
    console.log(`Circuit ${event.name}: ${event.previous} → ${event.next}`);
    console.log(`Reason: ${event.reason}, Failures: ${event.failureCount}`);
  },
});

// Guard calls with circuit breaker
try {
  const result = await breaker.execute(() =>
    fetch('https://api.example.com/data')
  );
} catch (error) {
  if (error.name === 'CircuitBreakerOpenError') {
    console.log(`Circuit open, retry after ${error.retryAfterMs}ms`);
  }
}
```

### Client Error Exemption

Circuit breaker intelligently ignores client errors (validation failures) to prevent false positives:

```typescript
// These errors DON'T count toward circuit breaker failure threshold:
// - InvalidRequest (-32600)
// - MethodNotFound (-32601)
// - InvalidParams (-32602)
// - ValidationError
// - InvalidParamsError

// These errors DO count:
// - InternalError (-32603)
// - ServerError (-32000 to -32099)
// - Transport errors
// - Timeouts
```

---

## Configuration

### Runtime Configuration

**File**: `config/runtime.yaml`

```yaml
# JSON-RPC Transport Configuration
json_rpc:
  # Request timeout
  default_timeout_ms: 30000  # 30 seconds

  # Retry policy
  retry:
    max_attempts: 3
    initial_delay_ms: 100
    max_delay_ms: 5000
    backoff_multiplier: 2.0
    jitter: 0.25
    retryable_errors:
      - TIMEOUT
      - ECONNRESET

  # Circuit breaker
  circuit_breaker:
    failure_threshold: 5
    recovery_timeout_ms: 10000
    half_open_max_calls: 1
    half_open_success_threshold: 2
    failure_window_ms: 60000

# Python Runtime Configuration
python_runtime:
  # Auto-restart on crash
  max_restarts: 3
  restart_delay_base_ms: 1000  # Exponential backoff

# Stream Configuration
stream_registry:
  default_timeout_ms: 300000  # 5 minutes
  max_active_streams: 10
```

### Environment-Specific Configuration

Override configuration for different environments:

```yaml
# Base configuration
json_rpc:
  retry:
    max_attempts: 3

# Production overrides
environments:
  production:
    json_rpc:
      retry:
        max_attempts: 5  # More aggressive retry in production
        max_delay_ms: 10000  # Higher cap
      circuit_breaker:
        failure_threshold: 10  # More tolerant

# Development overrides
  development:
    json_rpc:
      retry:
        max_attempts: 1  # Fail fast in development
```

---

## Best Practices

### 1. Handle Errors at the Right Level

```typescript
// ✅ GOOD: Handle at call site
try {
  const result = await engine.loadModel({ model: 'llama' });
  console.log('Model loaded:', result.descriptor.id);
} catch (error) {
  if (error instanceof EngineClientError) {
    switch (error.code) {
      case 'ModelLoadError':
        console.error('Failed to load model:', error.message);
        // Show user-friendly message
        break;
      case 'Timeout':
        console.error('Model loading timed out, try again');
        // Offer retry button
        break;
      default:
        console.error('Unexpected error:', error);
        // Log to error tracking service
    }
  } else {
    throw error; // Re-throw unexpected errors
  }
}

// ❌ BAD: Generic catch-all
try {
  await engine.loadModel({ model: 'llama' });
} catch (error) {
  console.error('Error:', error); // Too generic
}
```

### 2. Use Type Guards

```typescript
import { EngineClientError, TimeoutError } from '@defai.digital/mlx-serving';

function handleError(error: unknown): void {
  if (error instanceof TimeoutError) {
    console.log(`Operation timed out after ${error.timeout}ms`);
    console.log(`Method: ${error.method}, Request: ${error.requestId}`);
    return;
  }

  if (error instanceof EngineClientError) {
    console.log(`Engine error [${error.code}]: ${error.message}`);
    if (error.details) {
      console.log('Details:', error.details);
    }
    return;
  }

  // Unknown error
  console.error('Unexpected error:', error);
}
```

### 3. Monitor Circuit Breaker State

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

const engine = await createEngine();

// Access circuit breaker via internal bridge (if needed)
// Usually automatic - this is for monitoring/debugging only
```

### 4. Configure Timeouts Appropriately

```typescript
// Short timeout for fast operations
const tokens = await engine.tokenize({
  model: 'llama',
  text: 'hello',
}); // Uses default timeout (30s)

// Long timeout for generation
for await (const chunk of engine.createGenerator(
  {
    model: 'llama',
    prompt: 'Write a long story',
    max_tokens: 2000,
  },
  {
    timeoutMs: 300000, // 5 minutes for generation
  }
)) {
  process.stdout.write(chunk.text);
}
```

### 5. Handle AbortSignal

```typescript
const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10000);

try {
  for await (const chunk of engine.createGenerator(
    { model: 'llama', prompt: 'Hello' },
    { signal: controller.signal }
  )) {
    console.log(chunk.text);
  }
} catch (error) {
  if (error instanceof EngineClientError && error.code === 'Cancelled') {
    console.log('Generation cancelled by user');
  }
}
```

### 6. Log Errors with Context

```typescript
import { logger } from './logger.js';

try {
  const result = await engine.loadModel({ model: 'llama-3.2-3b' });
} catch (error) {
  if (error instanceof EngineClientError) {
    logger.error({
      code: error.code,
      message: error.message,
      details: error.details,
      model: 'llama-3.2-3b',
      timestamp: Date.now(),
    });
  }
  throw error;
}
```

---

## Troubleshooting

### Common Issues

#### 1. Circuit Breaker Keeps Opening

**Symptoms**: Requests fail with `CircuitBreakerOpenError`

**Diagnosis**:
```typescript
// Check circuit breaker state via logs
// Circuit "python-runtime": CLOSED → OPEN
// Reason: FAILURE_THRESHOLD_EXCEEDED, Failures: 5
```

**Solutions**:
- Increase `failure_threshold` if service is naturally flaky
- Reduce `recovery_timeout_ms` for faster recovery attempts
- Check Python runtime logs for root cause
- Verify model paths and configurations
- Check system resources (RAM, GPU)

#### 2. Retries Exhausted

**Symptoms**: Operation fails after 3 attempts

**Diagnosis**:
```typescript
// JSON-RPC request failed (method: load_model, attempts: 3)
```

**Solutions**:
- Increase `max_attempts` for more retries
- Increase `max_delay_ms` for longer wait between retries
- Add more error codes to `retryable_errors`
- Check if error is actually retryable (e.g., `InvalidParams` is not)

#### 3. Timeout Errors

**Symptoms**: Requests fail with `TimeoutError`

**Diagnosis**:
```typescript
// Request timed out after 30000ms: load_model (id: abc-123)
```

**Solutions**:
- Increase `default_timeout_ms` for slow operations
- Use per-request timeout overrides for long operations
- Check Python runtime performance (CPU/GPU saturation)
- Verify model size vs available memory
- Check disk I/O (model loading from disk)

#### 4. Python Runtime Crashes

**Symptoms**: Repeated restart logs, `max_restarts` exceeded

**Diagnosis**:
```typescript
// Python runtime crashed, restarting (attempt 1/3)
// Python runtime crashed, restarting (attempt 2/3)
// Python runtime crashed, restarting (attempt 3/3)
// Python runtime exceeded max restarts
```

**Solutions**:
- Check Python runtime logs for errors
- Verify MLX installation: `python -c "import mlx; print(mlx.__version__)"`
- Check system resources (OOM killer?)
- Verify model compatibility with MLX
- Increase `max_restarts` if transient failures
- Check for memory leaks in Python code

#### 5. Validation Errors Not Retried

**Behavior**: Request fails immediately without retry

**Explanation**: This is intentional! Validation errors (`InvalidParams`, `InvalidRequest`) are not retryable because they indicate client-side bugs.

**Solutions**:
- Fix the client code (invalid parameters)
- Check API documentation for correct parameter types
- Verify model IDs, paths, and configurations

---

## Examples

### Example 1: Basic Error Handling

```typescript
import { createEngine, EngineClientError } from '@defai.digital/mlx-serving';

async function loadModelSafely(modelId: string) {
  const engine = await createEngine();

  try {
    const model = await engine.loadModel({ model: modelId });
    console.log('Model loaded:', model.descriptor.id);
    return model;
  } catch (error) {
    if (error instanceof EngineClientError) {
      switch (error.code) {
        case 'ModelLoadError':
          console.error(`Failed to load model ${modelId}:`, error.message);
          // Notify user, suggest alternative models
          break;

        case 'Timeout':
          console.error(`Model loading timed out for ${modelId}`);
          // Offer retry button
          break;

        case 'ModelNotLoaded':
          console.error(`Model ${modelId} not found`);
          // Show available models
          break;

        default:
          console.error(`Unexpected error [${error.code}]:`, error.message);
          // Log to error tracking service (Sentry, DataDog, etc.)
      }
    } else {
      // Non-Engine error
      console.error('Unexpected error:', error);
      throw error;
    }
  } finally {
    await engine.dispose();
  }
}

loadModelSafely('llama-3.2-3b-instruct');
```

### Example 2: Custom Retry with Logging

```typescript
import { retryWithBackoff } from '@defai.digital/mlx-serving/utils/retry.js';
import { createEngine } from '@defai.digital/mlx-serving';

async function robustTokenize(text: string) {
  const engine = await createEngine();

  try {
    const result = await retryWithBackoff(
      () => engine.tokenize({ model: 'llama', text }),
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
        retryableErrors: ['TIMEOUT', 'ECONNRESET', 'TransportError'],
        jitter: 0.3,
        onRetry: (context) => {
          console.log(`[Retry ${context.attempt}] Retrying after ${context.delayMs}ms`);
          console.log(`[Retry ${context.attempt}] Error:`, context.error);
        },
      }
    );

    console.log('Tokenization successful:', result.tokens);
    return result;
  } finally {
    await engine.dispose();
  }
}

robustTokenize('Hello, world!');
```

### Example 3: Circuit Breaker Monitoring

```typescript
import { CircuitBreaker } from '@defai.digital/mlx-serving/utils/circuit-breaker.js';
import { createEngine } from '@defai.digital/mlx-serving';

// Create circuit breaker for external API
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  recoveryTimeoutMs: 5000,
  halfOpenMaxCalls: 1,
  halfOpenSuccessThreshold: 2,
  name: 'external-api',
  onStateChange: (event) => {
    console.log(`[Circuit ${event.name}] ${event.previous} → ${event.next}`);
    console.log(`  Reason: ${event.reason}`);
    console.log(`  Failures: ${event.failureCount}`);
    console.log(`  Timestamp: ${new Date(event.at).toISOString()}`);

    // Send alert on OPEN state
    if (event.next === 'OPEN') {
      sendAlert({
        level: 'error',
        message: `Circuit ${event.name} opened after ${event.failureCount} failures`,
        timestamp: event.at,
      });
    }

    // Send recovery notification on CLOSED state
    if (event.previous === 'HALF_OPEN' && event.next === 'CLOSED') {
      sendAlert({
        level: 'info',
        message: `Circuit ${event.name} recovered`,
        timestamp: event.at,
      });
    }
  },
});

async function callExternalAPI() {
  try {
    return await breaker.execute(async () => {
      const response = await fetch('https://api.example.com/data');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    });
  } catch (error) {
    if (error.name === 'CircuitBreakerOpenError') {
      console.error(`Circuit open, retry after ${error.retryAfterMs}ms`);
      return { fallback: true }; // Return cached data or fallback
    }
    throw error;
  }
}
```

### Example 4: Graceful Timeout Handling

```typescript
import { createEngine, TimeoutError } from '@defai.digital/mlx-serving';

async function generateWithTimeout(prompt: string, timeoutMs: number) {
  const engine = await createEngine();
  const controller = new AbortController();

  // Set timeout
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const chunks: string[] = [];

    for await (const chunk of engine.createGenerator(
      { model: 'llama', prompt },
      { signal: controller.signal }
    )) {
      chunks.push(chunk.text);
    }

    return chunks.join('');
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.log(`Generation timed out after ${error.timeout}ms`);
      console.log(`Method: ${error.method}, Duration: ${error.duration}ms`);
      return null; // Return partial results if available
    }

    if (error.name === 'AbortError' || (error instanceof EngineClientError && error.code === 'Cancelled')) {
      console.log('Generation cancelled by user');
      return null;
    }

    throw error;
  } finally {
    clearTimeout(timer);
    await engine.dispose();
  }
}

// Usage
const result = await generateWithTimeout('Write a story', 10000); // 10s timeout
if (result) {
  console.log('Generated:', result);
} else {
  console.log('Generation timed out or was cancelled');
}
```

### Example 5: Error Telemetry Integration

```typescript
import { createEngine, EngineClientError } from '@defai.digital/mlx-serving';
import * as Sentry from '@sentry/node';

async function generateWithTelemetry(prompt: string) {
  const engine = await createEngine();

  try {
    const chunks: string[] = [];

    for await (const chunk of engine.createGenerator({
      model: 'llama',
      prompt,
    })) {
      chunks.push(chunk.text);
    }

    return chunks.join('');
  } catch (error) {
    // Log to error tracking service
    if (error instanceof EngineClientError) {
      Sentry.withScope((scope) => {
        scope.setLevel('error');
        scope.setTag('error_code', error.code);
        scope.setContext('error_details', {
          code: error.code,
          message: error.message,
          details: error.details,
        });
        scope.setContext('request', {
          model: 'llama',
          prompt: prompt.substring(0, 100), // First 100 chars
        });
        Sentry.captureException(error);
      });
    } else {
      Sentry.captureException(error);
    }

    throw error;
  } finally {
    await engine.dispose();
  }
}
```

---

## See Also

- [Architecture Documentation](./ARCHITECTURE.md)
- [Configuration Guide](./CONFIGURATION.md)
- [Telemetry & Monitoring](./TELEMETRY.md)
- [Performance Tuning](./PERFORMANCE.md)

---

**Last Updated**: November 4, 2025
**Version**: v0.2.0
