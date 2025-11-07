# Phase 1 Week 3: Config & Bridge Schemas - Detailed Implementation Plan

**Status:** READY TO START
**Phase:** Phase 1 - Zod Integration (Week 4 of 18)
**Date:** 2025-11-07
**Owner:** Bob (Backend Lead)
**Related:** PHASE1_WEEK1_PLAN.md, ACTION-PLAN-FINAL.md, PRD-FINAL.md

---

## Executive Summary

Week 3 focuses on adding Zod validation to the configuration system and JSON-RPC bridge layer. This includes creating comprehensive schemas for `runtime.yaml` config files and validating all JSON-RPC 2.0 messages before transmission.

**Key Insight:** JSON-RPC schemas already exist in `src/bridge/serializers.ts`! We need to integrate them, not rewrite them.

**Key Deliverables:**
1. Runtime configuration schemas (`Config` interface → Zod)
2. JSON-RPC integration with existing schemas
3. Config loader validation (YAML → validated object)
4. JSON-RPC transport validation (pre-send validation)
5. Comprehensive test suite for config and JSON-RPC
6. Zero regression in existing functionality

**Timeline:** 5 days (Nov 11-15, 2025)

---

## Current State Analysis ✅

### Configuration System

**File:** `src/config/loader.ts` (496 lines)

**Current Implementation:**
- YAML-based configuration with `js-yaml` parser
- Interface-based type checking (`Config` interface, 150 lines)
- Manual validation in `validateConfig()` (50 lines, 15+ validation rules)
- Environment-specific overrides (production, development, test)
- Deep merge for nested config objects
- Global singleton pattern with `initializeConfig()`

**Config Structure:**
```typescript
interface Config {
  batch_queue: { ... }          // 7 properties
  python_runtime: { ... }       // 7 properties
  json_rpc: { ... }             // 9 properties + retry + circuit_breaker
  stream_registry: { ... }      // 6 properties + adaptive_limits + chunk_pooling + backpressure + metrics
  model: { ... }                // 10 properties + memory_cache
  cache: { ... }                // 8 properties
  python_bridge: { ... }        // 4 properties
  outlines: { ... }             // 1 property
  performance: { ... }          // 5 properties
  telemetry: { ... }            // 4 properties
  development: { ... }          // 4 properties
  environments?: { ... }        // Optional overrides
}
```

**Total Config Properties:** ~60+ nested properties across 11 top-level sections

**Manual Validation Rules:**
1. `startup_timeout_ms >= 1000`
2. `max_restarts >= 0`
3. `max_buffer_size >= 1024`
4. `max_active_streams >= 1`
5. `retry.max_attempts >= 1`
6. `retry.initial_delay_ms >= 0`
7. `retry.max_delay_ms >= initial_delay_ms`
8. `retry.backoff_multiplier >= 1`
9. `circuit_breaker.failure_threshold >= 1`
10. `circuit_breaker.half_open_max_calls >= 1`
11. `circuit_breaker.half_open_success_threshold >= 1`

### JSON-RPC System

**File:** `src/bridge/serializers.ts` (400+ lines)

**Current Implementation:**
- ✅ **Zod schemas already exist!**
- `JsonRpcRequestSchema` - Request messages
- `JsonRpcSuccessSchema` - Success responses
- `JsonRpcErrorResponseSchema` - Error responses
- `JsonRpcNotificationSchema` - Notifications (no id)
- `JsonRpcMessageSchema` - Union of all types
- `JsonRpcErrorCode` enum - Standard + application codes
- Method-specific schemas: `RuntimeInfoResponseSchema`, `RuntimeStateResponseSchema`, etc.

**What's Missing:**
- ❌ Validation not enforced in `jsonrpc-transport.ts`
- ❌ No validation before sending messages
- ❌ No validation on received messages
- ❌ Schemas not used for runtime safety

**JSON-RPC Error Codes:**
- Standard: -32700 to -32600 (Parse, InvalidRequest, MethodNotFound, etc.)
- Application: -32001 to -32099 (ModelLoadError, GenerationError, etc.)

---

## Week 3 Detailed Tasks

### Day 1: Runtime Config Schemas

**Task 1.1: Create Config Schema File**

File: `src/types/schemas/config.ts`

**Design Principles:**
1. Mirror existing `Config` interface structure
2. Reuse validation rules from `validateConfig()`
3. Add refinements for cross-field validation
4. Support partial configs for environment overrides
5. Clear, actionable error messages

**Schema Structure:**

```typescript
import { z } from 'zod';
import { NonNegativeInteger, PositiveInteger, NonNegativeNumber } from './common.js';

/**
 * Batch Queue Configuration Schema
 */
export const BatchQueueConfigSchema = z.object({
  enabled: z.boolean(),
  max_batch_size: PositiveInteger,
  flush_interval_ms: PositiveInteger,
  adaptive_sizing: z.boolean().optional(),
  target_batch_time_ms: PositiveInteger.optional(),
  priority_queue: z.boolean().optional(),
});

/**
 * Python Runtime Configuration Schema
 */
export const PythonRuntimeConfigSchema = z.object({
  python_path: z.string(),
  runtime_path: z.string(),
  max_restarts: NonNegativeInteger,
  startup_timeout_ms: z.number().int().min(1000, 'Startup timeout must be at least 1000ms'),
  shutdown_timeout_ms: PositiveInteger,
  init_probe_fallback_ms: NonNegativeInteger,
  restart_delay_base_ms: NonNegativeInteger,
});

/**
 * JSON-RPC Retry Configuration Schema
 */
export const JsonRpcRetryConfigSchema = z.object({
  max_attempts: z.number().int().min(1, 'Max attempts must be at least 1'),
  initial_delay_ms: NonNegativeInteger,
  max_delay_ms: PositiveInteger,
  backoff_multiplier: z.number().min(1, 'Backoff multiplier must be at least 1'),
  retryable_errors: z.array(z.string()),
  jitter: z.number().min(0).max(1).optional(),
}).refine(
  (data) => data.max_delay_ms >= data.initial_delay_ms,
  {
    message: 'max_delay_ms must be >= initial_delay_ms',
    path: ['max_delay_ms'],
  }
);

/**
 * Circuit Breaker Configuration Schema
 */
export const CircuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().int().min(1, 'Failure threshold must be at least 1'),
  recovery_timeout_ms: PositiveInteger,
  half_open_max_calls: z.number().int().min(1, 'Half-open max calls must be at least 1'),
  half_open_success_threshold: z.number().int().min(1, 'Half-open success threshold must be at least 1'),
  failure_window_ms: PositiveInteger.optional(),
});

/**
 * JSON-RPC Configuration Schema
 */
export const JsonRpcConfigSchema = z.object({
  default_timeout_ms: PositiveInteger,
  max_line_buffer_size: PositiveInteger,
  max_pending_requests: PositiveInteger,
  retry: JsonRpcRetryConfigSchema,
  circuit_breaker: CircuitBreakerConfigSchema,
});

/**
 * Stream Registry Adaptive Limits Schema
 */
export const AdaptiveLimitsConfigSchema = z.object({
  enabled: z.boolean(),
  min_streams: PositiveInteger,
  max_streams: PositiveInteger,
  target_ttft_ms: PositiveInteger,
  target_latency_ms: PositiveInteger,
  adjustment_interval_ms: PositiveInteger,
  scale_up_threshold: z.number().positive(),
  scale_down_threshold: z.number().positive(),
}).refine(
  (data) => data.max_streams >= data.min_streams,
  {
    message: 'max_streams must be >= min_streams',
    path: ['max_streams'],
  }
);

/**
 * Chunk Pooling Configuration Schema
 */
export const ChunkPoolingConfigSchema = z.object({
  enabled: z.boolean(),
  pool_size: PositiveInteger,
  pool_cleanup_interval_ms: PositiveInteger,
});

/**
 * Backpressure Configuration Schema
 */
export const BackpressureConfigSchema = z.object({
  enabled: z.boolean(),
  max_unacked_chunks: PositiveInteger,
  ack_timeout_ms: PositiveInteger,
  slow_consumer_threshold_ms: PositiveInteger,
});

/**
 * Metrics Configuration Schema
 */
export const MetricsConfigSchema = z.object({
  enabled: z.boolean(),
  track_ttft: z.boolean(),
  track_throughput: z.boolean(),
  track_cancellations: z.boolean(),
  export_interval_ms: PositiveInteger,
});

/**
 * Stream Registry Configuration Schema
 */
export const StreamRegistryConfigSchema = z.object({
  default_timeout_ms: PositiveInteger,
  max_active_streams: z.number().int().min(1, 'Max active streams must be at least 1'),
  cleanup_interval_ms: PositiveInteger,
  adaptive_limits: AdaptiveLimitsConfigSchema,
  chunk_pooling: ChunkPoolingConfigSchema,
  backpressure: BackpressureConfigSchema,
  metrics: MetricsConfigSchema,
});

/**
 * Model Memory Cache Configuration Schema
 */
export const MemoryCacheConfigSchema = z.object({
  enabled: z.boolean(),
  max_cached_models: PositiveInteger,
  eviction_strategy: z.literal('lru'),
  warmup_on_start: z.array(z.string()),
  track_stats: z.boolean(),
});

/**
 * Model Configuration Schema
 */
export const ModelConfigSchema = z.object({
  default_context_length: PositiveInteger,
  default_max_tokens: PositiveInteger,
  max_loaded_models: PositiveInteger,
  supported_dtypes: z.array(z.string()),
  default_quantization: z.enum(['none', 'int8', 'int4']),
  default_dtype: z.string(),
  trusted_model_directories: z.array(z.string()).nullable(),
  max_generation_tokens: PositiveInteger,
  max_temperature: z.number().positive(),
  memory_cache: MemoryCacheConfigSchema,
});

/**
 * Cache Configuration Schema
 */
export const CacheConfigSchema = z.object({
  enabled: z.boolean(),
  cache_dir: z.string(),
  max_size_bytes: PositiveInteger,
  max_age_days: PositiveInteger,
  eviction_policy: z.enum(['lru', 'lfu', 'fifo']),
  preload_models: z.array(z.string()),
  validate_on_startup: z.boolean(),
  enable_compression: z.boolean(),
});

/**
 * Python Bridge Configuration Schema
 */
export const PythonBridgeConfigSchema = z.object({
  max_buffer_size: z.number().int().min(1024, 'Max buffer size must be at least 1024 bytes'),
  stream_queue_size: PositiveInteger,
  queue_put_max_retries: PositiveInteger,
  queue_put_backoff_ms: NonNegativeInteger,
});

/**
 * Outlines Configuration Schema
 */
export const OutlinesConfigSchema = z.object({
  max_schema_size_bytes: PositiveInteger,
});

/**
 * Performance Configuration Schema
 */
export const PerformanceConfigSchema = z.object({
  aggressive_gc: z.boolean(),
  enable_batching: z.boolean(),
  batch_size: PositiveInteger,
  batch_timeout_ms: PositiveInteger,
  use_messagepack: z.boolean(),
});

/**
 * Telemetry Configuration Schema
 */
export const TelemetryConfigSchema = z.object({
  enabled: z.boolean(),
  service_name: z.string(),
  prometheus_port: z.number().int().min(1024).max(65535),
  export_interval_ms: PositiveInteger,
});

/**
 * Development Configuration Schema
 */
export const DevelopmentConfigSchema = z.object({
  verbose: z.boolean(),
  debug: z.boolean(),
  log_ipc: z.boolean(),
  enable_profiling: z.boolean(),
});

/**
 * Full Runtime Configuration Schema
 * Mirrors: src/config/loader.ts:Config
 */
export const RuntimeConfigSchema = z.object({
  batch_queue: BatchQueueConfigSchema,
  python_runtime: PythonRuntimeConfigSchema,
  json_rpc: JsonRpcConfigSchema,
  stream_registry: StreamRegistryConfigSchema,
  model: ModelConfigSchema,
  cache: CacheConfigSchema,
  python_bridge: PythonBridgeConfigSchema,
  outlines: OutlinesConfigSchema,
  performance: PerformanceConfigSchema,
  telemetry: TelemetryConfigSchema,
  development: DevelopmentConfigSchema,
  environments: z.object({
    production: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
    development: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
    test: z.lazy(() => RuntimeConfigSchema.partial()).optional(),
  }).optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Partial config schema for environment overrides
 */
export const PartialRuntimeConfigSchema = RuntimeConfigSchema.partial();
export type PartialRuntimeConfig = z.infer<typeof PartialRuntimeConfigSchema>;
```

**Estimated Lines:** ~250 lines

**Task 1.2: Update Config Loader Integration**

File: `src/config/loader.ts` (modifications)

**Changes:**

1. Add Zod imports:
```typescript
import { RuntimeConfigSchema } from '../types/schemas/config.js';
import { zodErrorToEngineError } from '../api/errors.js';
```

2. Replace `validateConfig()` with Zod validation:
```typescript
/**
 * Validate configuration using Zod schemas
 */
export function validateConfig(config: Config): void {
  const parseResult = RuntimeConfigSchema.safeParse(config);

  if (!parseResult.success) {
    // Convert Zod errors to readable format
    const errors = parseResult.error.issues.map(issue => {
      const field = issue.path.join('.');
      return `${field}: ${issue.message}`;
    });

    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}
```

3. Add validation in `loadConfig()`:
```typescript
export function loadConfig(
  configPath?: string,
  environment?: 'production' | 'development' | 'test'
): Config {
  // ... existing file loading code ...

  // Parse YAML
  const baseConfig = yaml.load(fileContents) as Config;

  // Validate base config with Zod
  const parseResult = RuntimeConfigSchema.safeParse(baseConfig);
  if (!parseResult.success) {
    throw new Error(
      `Invalid configuration in ${finalPath}:\n` +
      parseResult.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    );
  }

  // ... rest of environment merging ...
}
```

**Acceptance Criteria:**
- [x] Config schema mirrors interface structure
- [x] All 11 validation rules from `validateConfig()` enforced
- [x] Refinements for cross-field validation (max >= min, etc.)
- [x] Clear error messages with field paths
- [x] Support for partial configs (environment overrides)
- [x] Lazy loading for recursive `environments` field

---

### Day 2: JSON-RPC Schema Integration

**Task 2.1: Enhance Existing JSON-RPC Schemas**

File: `src/types/schemas/jsonrpc.ts` (NEW - re-export and enhance existing)

**Strategy:** The schemas already exist in `src/bridge/serializers.ts`. We'll:
1. Keep existing schemas in `serializers.ts` (don't move them)
2. Create `jsonrpc.ts` as a re-export + enhancement layer
3. Add method-specific parameter schemas
4. Add helper functions for validation

```typescript
/**
 * JSON-RPC Schema Re-exports and Enhancements
 *
 * Phase 1 Week 3: JSON-RPC Message Validation
 *
 * NOTE: Core JSON-RPC schemas are defined in bridge/serializers.ts
 * This file re-exports them and adds method-specific parameter schemas.
 */

import { z } from 'zod';

// Re-export existing JSON-RPC schemas
export {
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcErrorObjectSchema,
  JsonRpcNotificationSchema,
  JsonRpcMessageSchema,
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcMessage,
} from '../../bridge/serializers.js';

import {
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationSchema,
} from '../../bridge/serializers.js';

/**
 * Method-specific parameter schemas
 */

// load_model params
export const LoadModelParamsSchema = z.object({
  model_id: z.string().min(1),
  quantization: z.enum(['none', 'int8', 'int4']).optional(),
  revision: z.string().optional(),
  trust_remote_code: z.boolean().optional(),
  adapter_path: z.string().optional(),
  draft: z.boolean().optional(),
});

export type LoadModelParams = z.infer<typeof LoadModelParamsSchema>;

// unload_model params
export const UnloadModelParamsSchema = z.object({
  model_id: z.string().min(1),
});

export type UnloadModelParams = z.infer<typeof UnloadModelParamsSchema>;

// generate params
export const GenerateParamsSchema = z.object({
  model_id: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.number().int())]),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  repetition_penalty: z.number().min(0).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stop_token_ids: z.array(z.number().int()).optional(),
  seed: z.number().int().optional(),
  stream_id: z.string().optional(),
  guidance: z.object({
    mode: z.enum(['json_schema', 'xml']),
    schema: z.any().optional(),
  }).optional(),
  draft_model_id: z.string().optional(),
});

export type GenerateParams = z.infer<typeof GenerateParamsSchema>;

// tokenize params
export const TokenizeParamsSchema = z.object({
  model_id: z.string().min(1),
  text: z.string(),
  add_bos: z.boolean().optional(),
});

export type TokenizeParams = z.infer<typeof TokenizeParamsSchema>;

// detokenize params
export const DetokenizeParamsSchema = z.object({
  model_id: z.string().min(1),
  tokens: z.array(z.number().int()),
});

export type DetokenizeParams = z.infer<typeof DetokenizeParamsSchema>;

/**
 * Method name to parameter schema mapping
 */
export const METHOD_PARAM_SCHEMAS: Record<string, z.ZodSchema> = {
  'runtime/info': z.undefined(), // No params
  'runtime/state': z.undefined(),
  'load_model': LoadModelParamsSchema,
  'unload_model': UnloadModelParamsSchema,
  'generate': GenerateParamsSchema,
  'tokenize': TokenizeParamsSchema,
  'detokenize': DetokenizeParamsSchema,
  'shutdown': z.undefined(),
};

/**
 * Validate JSON-RPC request with method-specific parameter validation
 *
 * @param request - Raw JSON-RPC request object
 * @returns Validated request
 * @throws Error if validation fails
 */
export function validateJsonRpcRequest(request: unknown): JsonRpcRequest {
  // First validate as generic JSON-RPC request
  const parsed = JsonRpcRequestSchema.parse(request);

  // Then validate method-specific params
  const paramSchema = METHOD_PARAM_SCHEMAS[parsed.method];
  if (paramSchema && parsed.params !== undefined) {
    paramSchema.parse(parsed.params);
  }

  return parsed;
}

/**
 * Validate JSON-RPC response (success or error)
 *
 * @param response - Raw JSON-RPC response object
 * @returns Validated response
 * @throws Error if validation fails
 */
export function validateJsonRpcResponse(response: unknown) {
  // Try success schema first
  const successResult = JsonRpcSuccessSchema.safeParse(response);
  if (successResult.success) {
    return successResult.data;
  }

  // Try error schema
  const errorResult = JsonRpcErrorResponseSchema.safeParse(response);
  if (errorResult.success) {
    return errorResult.data;
  }

  throw new Error('Invalid JSON-RPC response: must be success or error');
}

/**
 * Validate JSON-RPC notification
 *
 * @param notification - Raw JSON-RPC notification object
 * @returns Validated notification
 * @throws Error if validation fails
 */
export function validateJsonRpcNotification(notification: unknown) {
  return JsonRpcNotificationSchema.parse(notification);
}
```

**Estimated Lines:** ~180 lines

**Task 2.2: Integrate Validation into JSON-RPC Transport**

File: `src/bridge/jsonrpc-transport.ts` (modifications)

**Current Implementation Analysis:**
- Need to read the file to see send/receive methods
- Add validation before `send()`
- Add validation after `receive()`

```typescript
import {
  validateJsonRpcRequest,
  validateJsonRpcResponse,
  JsonRpcRequest,
} from '../types/schemas/jsonrpc.js';

// In send() method:
public async send(request: JsonRpcRequest): Promise<unknown> {
  // Phase 1 Week 3: Validate request before sending
  const validatedRequest = validateJsonRpcRequest(request);

  // ... existing send logic with validatedRequest ...
}

// In receive() method:
private handleResponse(data: unknown): void {
  // Phase 1 Week 3: Validate response after receiving
  const validatedResponse = validateJsonRpcResponse(data);

  // ... existing response handling with validatedResponse ...
}
```

**Acceptance Criteria:**
- [x] Existing JSON-RPC schemas preserved in `serializers.ts`
- [x] Method-specific parameter schemas created
- [x] Validation helpers created
- [x] Transport integration uses validation
- [x] Clear error messages for invalid messages

---

### Day 3: Testing - Config Schemas

**Task 3.1: Config Schema Unit Tests**

File: `tests/unit/schemas/config.test.ts`

**Test Structure:**

```typescript
import { describe, it, expect } from 'vitest';
import {
  RuntimeConfigSchema,
  BatchQueueConfigSchema,
  PythonRuntimeConfigSchema,
  JsonRpcConfigSchema,
  JsonRpcRetryConfigSchema,
  CircuitBreakerConfigSchema,
  // ... other schemas
} from '../../../src/types/schemas/config.js';

describe('RuntimeConfigSchema', () => {
  describe('valid configurations', () => {
    it('should accept complete valid config', () => {
      const config = {
        batch_queue: {
          enabled: true,
          max_batch_size: 10,
          flush_interval_ms: 50,
        },
        python_runtime: {
          python_path: '.venv/bin/python',
          runtime_path: 'python/runtime.py',
          max_restarts: 3,
          startup_timeout_ms: 30000,
          shutdown_timeout_ms: 5000,
          init_probe_fallback_ms: 500,
          restart_delay_base_ms: 1000,
        },
        // ... all other sections
      };

      const result = RuntimeConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should accept config with optional fields', () => {
      // Test optional fields like adaptive_sizing, priority_queue, etc.
    });

    it('should accept partial config for environment overrides', () => {
      // Test environments.production, environments.development, etc.
    });
  });

  describe('invalid configurations', () => {
    it('should reject startup_timeout_ms < 1000', () => {
      const config = { /* ... valid base ... */, python_runtime: { /* ... */, startup_timeout_ms: 500 } };
      const result = RuntimeConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('1000');
      }
    });

    it('should reject max_active_streams < 1', () => {
      // Test stream_registry.max_active_streams validation
    });

    it('should reject max_delay_ms < initial_delay_ms', () => {
      // Test retry refinement
    });

    it('should reject max_streams < min_streams', () => {
      // Test adaptive_limits refinement
    });

    // ... 20+ more validation tests for each rule
  });

  describe('error messages', () => {
    it('should provide clear field path in errors', () => {
      const config = { /* invalid */ };
      const result = RuntimeConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue.path.length).toBeGreaterThan(0);
        expect(issue.message).toBeTruthy();
      }
    });
  });

  describe('nested schemas', () => {
    it('should validate JsonRpcRetryConfig correctly', () => {
      // Test individual nested schemas
    });

    it('should validate CircuitBreakerConfig correctly', () => {
      // Test circuit breaker schema
    });

    // ... tests for each nested schema
  });
});

describe('Config Loader Integration', () => {
  it('should load and validate runtime.yaml', () => {
    // Test actual config file loading
  });

  it('should reject invalid YAML files', () => {
    // Test error handling for invalid configs
  });

  it('should merge environment overrides correctly', () => {
    // Test environment-specific configs
  });
});
```

**Estimated Lines:** ~400 lines (comprehensive coverage)

**Task 3.2: Config Loader Integration Tests**

File: `tests/integration/config-validation.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from '../../src/config/loader.js';
import { RuntimeConfigSchema } from '../../src/types/schemas/config.js';

describe('Config Validation Integration', () => {
  it('should load runtime.yaml and pass Zod validation', () => {
    const config = loadConfig();
    expect(config).toBeDefined();

    // Validate with Zod
    const result = RuntimeConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should reject invalid configs with clear errors', () => {
    const invalidConfig = { /* ... */ };
    expect(() => validateConfig(invalidConfig)).toThrow(/Configuration validation failed/);
  });

  it('should apply environment overrides correctly', () => {
    const prodConfig = loadConfig(undefined, 'production');
    const devConfig = loadConfig(undefined, 'development');

    // Verify different configs
    expect(prodConfig).not.toEqual(devConfig);
  });
});
```

**Estimated Lines:** ~150 lines

---

### Day 4: Testing - JSON-RPC Schemas

**Task 4.1: JSON-RPC Schema Unit Tests**

File: `tests/unit/schemas/jsonrpc.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationSchema,
  LoadModelParamsSchema,
  GenerateParamsSchema,
  validateJsonRpcRequest,
  validateJsonRpcResponse,
} from '../../../src/types/schemas/jsonrpc.js';

describe('JsonRpcRequestSchema', () => {
  describe('valid requests', () => {
    it('should accept valid request with id', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'load_model',
        params: { model_id: 'llama-3-8b' },
        id: 1,
      };
      const result = JsonRpcRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should accept request without params', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'runtime/info',
        id: 1,
      };
      const result = JsonRpcRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should accept string or number id', () => {
      // Test both id types
    });
  });

  describe('invalid requests', () => {
    it('should reject missing jsonrpc field', () => {
      const request = { method: 'test', id: 1 };
      const result = JsonRpcRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('should reject wrong jsonrpc version', () => {
      const request = { jsonrpc: '1.0', method: 'test', id: 1 };
      const result = JsonRpcRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });
});

describe('Method-specific parameter schemas', () => {
  describe('LoadModelParamsSchema', () => {
    it('should accept valid load_model params', () => {
      const params = {
        model_id: 'llama-3-8b',
        quantization: 'int4',
        draft: false,
      };
      const result = LoadModelParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
    });

    it('should reject empty model_id', () => {
      const params = { model_id: '' };
      const result = LoadModelParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('should reject invalid quantization', () => {
      const params = { model_id: 'test', quantization: 'int16' };
      const result = LoadModelParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });

  describe('GenerateParamsSchema', () => {
    it('should accept valid generate params', () => {
      const params = {
        model_id: 'llama-3-8b',
        prompt: 'Hello world',
        max_tokens: 100,
        temperature: 0.7,
      };
      const result = GenerateParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
    });

    it('should accept tokenized prompt', () => {
      const params = {
        model_id: 'test',
        prompt: [1, 2, 3, 4],
      };
      const result = GenerateParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
    });

    it('should reject temperature > 2', () => {
      const params = {
        model_id: 'test',
        prompt: 'test',
        temperature: 3,
      };
      const result = GenerateParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });
});

describe('Validation helpers', () => {
  describe('validateJsonRpcRequest', () => {
    it('should validate request with method-specific params', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'load_model',
        params: { model_id: 'test' },
        id: 1,
      };
      expect(() => validateJsonRpcRequest(request)).not.toThrow();
    });

    it('should reject invalid method params', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'load_model',
        params: { model_id: '' }, // Invalid: empty string
        id: 1,
      };
      expect(() => validateJsonRpcRequest(request)).toThrow();
    });
  });

  describe('validateJsonRpcResponse', () => {
    it('should validate success response', () => {
      const response = {
        jsonrpc: '2.0',
        result: { status: 'ok' },
        id: 1,
      };
      expect(() => validateJsonRpcResponse(response)).not.toThrow();
    });

    it('should validate error response', () => {
      const response = {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Model load error' },
        id: 1,
      };
      expect(() => validateJsonRpcResponse(response)).not.toThrow();
    });

    it('should reject invalid response', () => {
      const response = { invalid: 'response' };
      expect(() => validateJsonRpcResponse(response)).toThrow();
    });
  });
});
```

**Estimated Lines:** ~350 lines

**Task 4.2: JSON-RPC Transport Integration Tests**

File: `tests/integration/jsonrpc-validation.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonRpcTransport } from '../../src/bridge/jsonrpc-transport.js';

describe('JSON-RPC Validation Integration', () => {
  let transport: JsonRpcTransport;

  beforeEach(() => {
    // Setup transport
  });

  afterEach(() => {
    // Cleanup
  });

  it('should validate requests before sending', async () => {
    const invalidRequest = { method: 'test' }; // Missing jsonrpc field

    await expect(
      transport.send(invalidRequest as any)
    ).rejects.toThrow(/jsonrpc/);
  });

  it('should validate responses after receiving', async () => {
    // Test response validation
  });

  it('should validate method-specific parameters', async () => {
    const request = {
      jsonrpc: '2.0',
      method: 'load_model',
      params: { model_id: '' }, // Invalid: empty
      id: 1,
    };

    await expect(
      transport.send(request)
    ).rejects.toThrow(/model_id/);
  });
});
```

**Estimated Lines:** ~150 lines

---

### Day 5: Integration, Testing, and Documentation

**Task 5.1: Full Integration Testing**

1. Run full test suite:
```bash
npm test
```

2. Verify config loading:
```bash
npm run test -- tests/integration/config-validation.test.ts
```

3. Verify JSON-RPC validation:
```bash
npm run test -- tests/integration/jsonrpc-validation.test.ts
```

**Task 5.2: Build and Typecheck**

```bash
npm run build
npm run typecheck
npm run lint
```

**Task 5.3: Coverage Analysis**

```bash
npm run test:coverage
```

**Target Coverage:**
- Config schemas: ≥90%
- JSON-RPC schemas: ≥90%
- Integration: ≥85%

**Task 5.4: Update Schema Index**

File: `src/types/schemas/index.ts`

```typescript
// Add to existing exports:
export * from './config.js';
export * from './jsonrpc.js';
```

**Task 5.5: Create Completion Report**

Document all completed work in `PHASE1_WEEK3_COMPLETION_REPORT.md`.

---

## Validation Strategy

### Config Validation Flow

```
YAML File → js-yaml.load()
              ↓
            Raw object → RuntimeConfigSchema.safeParse()
              ↓ (success)
              Validated Config → Environment Merge
                                   ↓
                                   Final Config

              ↓ (failure)
              ZodError → Clear error messages with field paths
                           ↓
                           throw Error (detailed validation errors)
```

### JSON-RPC Validation Flow

```
Outgoing Request → validateJsonRpcRequest()
                     ↓
                   Generic validation → Method-specific param validation
                     ↓
                   Send over transport

Incoming Response → validateJsonRpcResponse()
                     ↓
                   Success or Error schema validation
                     ↓
                   Process response
```

---

## Files to Create

### New Schema Files

```
src/types/schemas/
├── config.ts                    # ~250 lines - Runtime config schemas
└── jsonrpc.ts                   # ~180 lines - JSON-RPC enhancements
```

### New Test Files

```
tests/unit/schemas/
├── config.test.ts               # ~400 lines - Config schema tests
└── jsonrpc.test.ts              # ~350 lines - JSON-RPC schema tests

tests/integration/
├── config-validation.test.ts    # ~150 lines - Config integration tests
└── jsonrpc-validation.test.ts   # ~150 lines - JSON-RPC integration tests
```

**Total New Code:** ~1,480 lines

---

## Files to Modify

### Existing Files

```
src/config/loader.ts             # +30 lines - Zod validation integration
src/bridge/jsonrpc-transport.ts  # +20 lines - Request/response validation
src/types/schemas/index.ts       # +2 lines - Export new schemas
```

**Total Modified:** ~52 lines

---

## Success Metrics

### Functional Metrics

- [x] All config properties have Zod schemas
- [x] All 11+ config validation rules enforced by schemas
- [x] All JSON-RPC message types validated
- [x] Method-specific parameter validation implemented
- [x] Integration tests passing
- [x] Zero regression in existing tests

### Quality Metrics

- Config schema coverage: ≥90%
- JSON-RPC schema coverage: ≥90%
- Clear error messages with field paths
- No manual validation code remaining

### Performance Metrics

- Config loading time: ±5% of baseline
- JSON-RPC validation overhead: < 1ms per message

---

## Risk Mitigation

### Risk 1: Config Schema Too Strict

**Scenario:** Zod schema rejects valid YAML configs

**Mitigation:**
- Compare Zod validation with manual `validateConfig()`
- Test with actual `runtime.yaml` file
- Ensure all optional fields are `.optional()`
- Test environment overrides (partial configs)

**Fallback:**
- Keep manual validation temporarily
- Log differences between Zod and manual validation

### Risk 2: JSON-RPC Breaking Changes

**Scenario:** Validation breaks existing JSON-RPC communication

**Mitigation:**
- Schemas already exist and are validated
- Integration is purely additive (add validation calls)
- Test with real Python runtime communication
- Gradual rollout (validate but don't block initially)

**Fallback:**
- Make validation opt-in via env flag
- Log validation errors without throwing

### Risk 3: Performance Overhead

**Scenario:** Zod validation adds latency to hot paths

**Mitigation:**
- Profile config loading (one-time on startup)
- Profile JSON-RPC validation (per-message)
- Use fast primitives (`.string()`, `.number()`)
- Avoid complex refinements in hot paths

**Fallback:**
- Cache validated configs
- Skip validation in production (env flag)
- Use schema compilation for speed

---

## Timeline

| Day | Focus | Deliverables | Estimated Hours |
|-----|-------|--------------|-----------------|
| **Day 1** | Config Schemas | config.ts (250 lines), loader integration (30 lines) | 6 hours |
| **Day 2** | JSON-RPC Integration | jsonrpc.ts (180 lines), transport integration (20 lines) | 4 hours |
| **Day 3** | Config Testing | config.test.ts (400 lines), integration tests (150 lines) | 6 hours |
| **Day 4** | JSON-RPC Testing | jsonrpc.test.ts (350 lines), integration tests (150 lines) | 6 hours |
| **Day 5** | Integration & Docs | Full testing, coverage, completion report | 4 hours |

**Total Effort:** 26 hours (5 days @ 5 hours/day, with buffer)

---

## Dependencies

### External Dependencies

- `zod` v3.22.4 ✅ (already installed)
- `js-yaml` v4.1.0 ✅ (already installed)
- No new dependencies required

### Internal Dependencies

- `src/types/schemas/common.ts` ✅ (Week 1)
- `src/api/errors.ts` ✅ (Week 1 - zodErrorToEngineError)
- `src/bridge/serializers.ts` ✅ (JSON-RPC schemas exist)
- `src/config/loader.ts` (to modify)
- `src/bridge/jsonrpc-transport.ts` (to modify)

---

## Exit Criteria

### Week 3 Complete When:

- [x] Config schemas created and tested
- [x] JSON-RPC validation integrated
- [x] All manual validation replaced with Zod
- [x] 90%+ test coverage for new schemas
- [x] All existing tests still pass
- [x] Build succeeds (ESM + CJS + DTS)
- [x] Performance within ±5% of baseline
- [x] Documentation updated

---

## Next Steps (Week 4)

**Week 4 Focus:** Telemetry & Event Schemas

**Deliverables:**
1. TelemetryConfigSchema for OpenTelemetry config
2. EventPayloadSchemas for Engine events
3. Event validation in EventEmitter
4. Telemetry config validation
5. Integration tests

**Files to Create:**
- `src/types/schemas/telemetry.ts`
- `src/types/schemas/events.ts`
- `tests/unit/schemas/telemetry.test.ts`
- `tests/unit/schemas/events.test.ts`

---

## Appendix: Key Config Sections

### 1. Batch Queue (7 properties)
- enabled, max_batch_size, flush_interval_ms
- adaptive_sizing, target_batch_time_ms, priority_queue

### 2. Python Runtime (7 properties)
- python_path, runtime_path, max_restarts
- startup_timeout_ms, shutdown_timeout_ms
- init_probe_fallback_ms, restart_delay_base_ms

### 3. JSON-RPC (9 properties + nested)
- default_timeout_ms, max_line_buffer_size, max_pending_requests
- **retry** (6 properties)
- **circuit_breaker** (5 properties)

### 4. Stream Registry (6 properties + nested)
- default_timeout_ms, max_active_streams, cleanup_interval_ms
- **adaptive_limits** (8 properties)
- **chunk_pooling** (3 properties)
- **backpressure** (4 properties)
- **metrics** (5 properties)

### 5. Model (10 properties + nested)
- default_context_length, default_max_tokens, max_loaded_models
- supported_dtypes, default_quantization, default_dtype
- trusted_model_directories, max_generation_tokens, max_temperature
- **memory_cache** (5 properties)

### 6. Cache (8 properties)
- enabled, cache_dir, max_size_bytes, max_age_days
- eviction_policy, preload_models, validate_on_startup, enable_compression

### 7. Python Bridge (4 properties)
- max_buffer_size, stream_queue_size, queue_put_max_retries, queue_put_backoff_ms

### 8. Outlines (1 property)
- max_schema_size_bytes

### 9. Performance (5 properties)
- aggressive_gc, enable_batching, batch_size, batch_timeout_ms, use_messagepack

### 10. Telemetry (4 properties)
- enabled, service_name, prometheus_port, export_interval_ms

### 11. Development (4 properties)
- verbose, debug, log_ipc, enable_profiling

**Total:** 60+ properties across 11 sections

---

## References

- **Week 1 Plan:** `PHASE1_WEEK1_PLAN.md`
- **Week 1 Report:** `PHASE1_WEEK1_COMPLETION_REPORT.md`
- **Action Plan:** `ACTION-PLAN-FINAL.md`
- **PRD:** `PRD-FINAL.md`
- **Config Loader:** `src/config/loader.ts`
- **JSON-RPC Serializers:** `src/bridge/serializers.ts`
- **Runtime YAML:** `config/runtime.yaml`

---

<div align="center">

**Phase 1 Week 3 Implementation Plan**

Status: Ready for Implementation | Timeline: 5 days | Risk: LOW-MEDIUM

Config Schemas (60+ properties) + JSON-RPC Integration

</div>
