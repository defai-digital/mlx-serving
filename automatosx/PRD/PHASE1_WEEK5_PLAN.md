# Phase 1 Week 5: Integration & Error Handling - Detailed Implementation Plan

**Date:** 2025-11-07
**Phase:** Phase 1 - Zod Integration (Week 5 of 18)
**Status:** READY TO START
**Timeline:** 5 days (26 hours total)
**Owner:** Bob (Backend Lead)
**Related:** ACTION-PLAN-FINAL.md, PRD-FINAL.md, PHASE1_WEEK4_PLAN.md

---

## Executive Summary

Week 5 completes the **Zod validation integration** across all Engine API methods, replacing manual validators with schema-based validation. This is the integration week that brings together all schemas from Weeks 1-4.

### Scope

**What This Week Delivers:**
1. **Complete Zod Integration** - All 20+ Engine API methods use Zod validation
2. **Migration from Manual Validators** - Replace validators.ts with Zod schemas
3. **Comprehensive Integration Tests** - Validate Zod works end-to-end (~800 lines)
4. **Performance Validation** - Ensure no regression (< 5% overhead)
5. **Contract Tests** - Validate compatibility with kr-serve-mlx

**What's NOT in Scope:**
- New schema creation (completed Weeks 1-4)
- Documentation (Week 6)
- Manual validator removal (keep for backward compatibility)

---

## Context: Building on Weeks 1-4

### Week 1-4 Accomplishments ✅

**Week 1:** Core API Schemas (80% complete)
- LoadModelOptions, GeneratorParams, TokenizeRequest schemas
- zodErrorToEngineError converter
- Schema infrastructure (src/types/schemas/)

**Week 2:** Complete Week 1 + Testing (Planned)
- Fix 50+ pre-existing TypeScript errors
- Integrate Zod into 4 core methods
- Write ~950 lines of schema tests

**Week 3:** Config & Bridge Schemas (Planned)
- RuntimeConfig schema (60+ properties)
- JSON-RPC validation
- Config loader integration

**Week 4:** Telemetry & Event Schemas (Planned)
- TelemetryConfig schema
- 8 event payload schemas
- Telemetry/event validation integration

**Week 5 (This Plan):** Integration & Error Handling
- Complete Zod integration for ALL Engine methods
- Replace manual validators with Zod
- Comprehensive integration tests
- Performance validation

---

## Technical Analysis

### Current State: Manual Validators

**File:** `src/api/validators.ts` (323 lines)

**Manual Validation Functions:**
1. `validateLoadModelOptions()` - Returns ValidationResult
2. `validateGeneratorParams()` - Returns ValidationResult
3. `validateTokenizeRequest()` - Returns ValidationResult
4. `assertValidLoadModelOptions()` - Throws EngineClientError
5. `assertValidGeneratorParams()` - Throws EngineClientError
6. `assertValidTokenizeRequest()` - Throws EngineClientError

**Utility Functions:**
- `sanitizeModelId()` - Path traversal protection
- `isValidModelIdFormat()` - Regex validation
- `clamp()`, `normalizeTemperature()`, `normalizeTopP()` - Value normalization

**Issues with Manual Validators:**
- **Maintenance burden**: 323 lines of validation logic to maintain
- **Duplication**: Validation rules duplicated across validators
- **Type safety**: ValidationResult.errors is string[], not structured
- **Incomplete coverage**: Some edge cases not validated (e.g., structured output)

### Target State: Zod Validators

**Migration Strategy:**
1. **Keep manual validators** (for backward compatibility, mark as deprecated)
2. **Add Zod validation** in Engine methods (before manual validation)
3. **Deprecate manual validators** with JSDoc warnings
4. **Remove in v1.0.0** (future milestone)

**Benefits of Zod:**
- **Single source of truth**: Schemas define both types and validation
- **Better error messages**: Field-level details with structured issues
- **Type safety**: z.infer<> ensures types match validation
- **Comprehensive coverage**: All edge cases validated consistently

---

## Week 5 Detailed Plan

### Day 1: Complete Engine Integration (6 hours)

#### Morning: Core API Methods (3 hours)

**Goal:** Integrate Zod validation into 4 core methods (from Week 2)

**Methods to Update:**

**1. loadModel()** (engine.ts:200)

**Current Code:**
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid model options');
  }
  // ... rest of implementation
}
```

**Add Zod Validation:**
```typescript
import {
  LoadModelOptionsSchema,
  GeneratorParamsWithStructuredSchema,
  TokenizeRequestSchema,
  zodErrorToEngineError,
} from '../types/schemas/index.js';

public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // Zod validation (Phase 1 Week 5)
  const opts = typeof options === 'string' ? { model: options } : options;
  const parseResult = LoadModelOptionsSchema.safeParse(opts);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // Existing normalization (keep for now)
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid model options');
  }

  // ... rest of implementation unchanged
}
```

**2. loadDraftModel()** (engine.ts:248)

**Current Code:**
```typescript
public async loadDraftModel(options: LoadModelOptions): Promise<ModelHandle> {
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid draft model options');
  }
  // ... rest
}
```

**Add Zod Validation:**
```typescript
public async loadDraftModel(options: LoadModelOptions): Promise<ModelHandle> {
  // Zod validation
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // Existing normalization
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid draft model options');
  }

  // ... rest unchanged
}
```

**3. createGenerator()** (engine.ts:445)

**Current Code:**
```typescript
public createGenerator(params: GeneratorParams): AsyncGenerator<GeneratorChunk, void> {
  // No validation currently!
  // ... implementation
}
```

**Add Zod Validation:**
```typescript
public createGenerator(params: GeneratorParams): AsyncGenerator<GeneratorChunk, void> {
  // Zod validation (Phase 1 Week 5)
  const parseResult = GeneratorParamsWithStructuredSchema.safeParse(params);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest unchanged
}
```

**4. tokenize()** (engine.ts:763)

**Current Code:**
```typescript
public async tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
  // No validation currently!
  // ... implementation
}
```

**Add Zod Validation:**
```typescript
public async tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
  // Zod validation (Phase 1 Week 5)
  const parseResult = TokenizeRequestSchema.safeParse(request);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest unchanged
}
```

**Total Changes:** ~40 lines added to engine.ts

#### Afternoon: Vision & Extended Methods (3 hours)

**Goal:** Integrate Zod validation into vision and extended methods

**Methods to Update:**

**5. loadVisionModel()** (engine.ts:379)

**Note:** VisionModelOptions is not yet in Zod schemas (Week 2-3 scope)
**Action:** Skip for now OR create minimal schema

**Decision:** Create minimal VisionModelOptionsSchema

```typescript
// Add to src/types/schemas/model.ts
export const VisionModelOptionsSchema = z.object({
  model: NonEmptyString,
  visionEncoder: NonEmptyString.optional(),
  revision: z.string().optional(),
  quantization: QuantizationMode.optional(),
  trustRemoteCode: z.boolean().optional(),
}).passthrough();

export type VisionModelOptions = z.infer<typeof VisionModelOptionsSchema>;
```

**Integration:**
```typescript
public async loadVisionModel(options: LoadVisionModelOptions): Promise<VisionModelHandle> {
  // Zod validation
  const parseResult = VisionModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest unchanged
}
```

**6. createVisionGenerator()** (engine.ts:528)

**Note:** VisionGeneratorParams is not yet in Zod schemas
**Action:** Create minimal VisionGeneratorParamsSchema

```typescript
// Add to src/types/schemas/generator.ts
export const VisionGeneratorParamsSchema = z.object({
  model: NonEmptyString,
  prompt: z.string(),
  images: z.array(z.string()).min(1, 'At least one image required'),
  maxTokens: PositiveInteger.max(100000).optional(),
  temperature: ClampedTemperature.optional(),
  topP: ClampedTopP.optional(),
}).passthrough();

export type VisionGeneratorParams = z.infer<typeof VisionGeneratorParamsSchema>;
```

**Integration:**
```typescript
public createVisionGenerator(params: VisionGeneratorParams): AsyncGenerator<VisionGeneratorChunk, void> {
  // Zod validation
  const parseResult = VisionGeneratorParamsSchema.safeParse(params);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest unchanged
}
```

**7. generate()** (engine.ts:513)

**Note:** This method delegates to createGenerator(), validation handled there
**Action:** No changes needed

**Total Changes:** ~60 lines to schemas, ~20 lines to engine.ts

---

### Day 2: Config & Advanced Methods (5 hours)

#### Morning: Config Validation Integration (3 hours)

**Goal:** Integrate RuntimeConfigSchema into config loader

**File:** `src/config/loader.ts`

**Current Code (loader.ts:235-296):**
```typescript
export function loadConfig(
  configPath?: string,
  environment?: string
): Config {
  // Load YAML
  const rawConfig = yaml.load(fileContents) as Config;

  // Apply environment overrides
  const mergedConfig = applyEnvironmentOverrides(rawConfig, environment);

  // Validate config
  validateConfig(mergedConfig);

  return mergedConfig;
}

export function validateConfig(config: Config): void {
  // Manual validation (100+ lines of if statements)
  if (!config.batch_queue) {
    throw new Error('batch_queue section is required');
  }
  // ... 100+ more lines
}
```

**Add Zod Validation:**

**Step 1:** Import RuntimeConfigSchema (from Week 3)
```typescript
import { RuntimeConfigSchema, zodErrorToEngineError } from '../types/schemas/index.js';
```

**Step 2:** Replace validateConfig() with Zod
```typescript
export function validateConfig(config: Config): void {
  // Zod validation (Phase 1 Week 5)
  const parseResult = RuntimeConfigSchema.safeParse(config);
  if (!parseResult.success) {
    // Convert Zod error to standard Error for config loading
    const engineError = zodErrorToEngineError(parseResult.error);
    throw new Error(`Config validation failed: ${engineError.message}`, {
      cause: engineError,
    });
  }
}
```

**Step 3:** Keep manual validation as fallback (deprecated)
```typescript
/**
 * Validate config manually (DEPRECATED - use RuntimeConfigSchema)
 * @deprecated Use RuntimeConfigSchema.parse() instead
 * @internal
 */
function validateConfigManual(config: Config): void {
  // ... existing manual validation logic
}
```

**Total Changes:** ~10 lines to loader.ts, deprecate ~100 lines

#### Afternoon: Advanced API Methods (2 hours)

**Goal:** Add validation to remaining Engine methods

**Methods to Update:**

**8. warmupModel()** (engine.ts:905)

**Current Code:**
```typescript
public async warmupModel(options: LoadModelOptions | string): Promise<void> {
  // No validation
  // ... implementation
}
```

**Add Zod Validation:**
```typescript
public async warmupModel(options: LoadModelOptions | string): Promise<void> {
  // Zod validation
  const opts = typeof options === 'string' ? { model: options } : options;
  const parseResult = LoadModelOptionsSchema.safeParse(opts);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest unchanged
}
```

**9-20. Other methods:**

Most other methods (unloadModel, getModelInfo, listModels, etc.) take simple parameters (string IDs, no options) that don't require Zod validation.

**Decision:** Focus on methods with complex object parameters only.

**Methods Requiring Validation:**
1. ✅ loadModel() - LoadModelOptions
2. ✅ loadDraftModel() - LoadModelOptions
3. ✅ createGenerator() - GeneratorParams
4. ✅ tokenize() - TokenizeRequest
5. ✅ loadVisionModel() - VisionModelOptions (new schema)
6. ✅ createVisionGenerator() - VisionGeneratorParams (new schema)
7. ✅ warmupModel() - LoadModelOptions

**Total:** 7 methods with Zod validation

---

### Day 3: Integration Tests (6 hours)

#### Morning: Schema Integration Tests (3 hours)

**File:** `tests/integration/zod-validation.test.ts` (~300 lines)

**Test Structure:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Engine } from '@/api/engine.js';
import type { LoadModelOptions, GeneratorParams, TokenizeRequest } from '@/types/index.js';

describe('Zod Validation Integration', () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = new Engine({
      pythonPath: 'python3',
      runtimePath: './python/src',
    });
    await engine.start();
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  describe('loadModel() validation', () => {
    it('should reject empty model identifier', async () => {
      await expect(
        engine.loadModel({ model: '' })
      ).rejects.toThrow(/Validation error on field 'model'/);
    });

    it('should reject invalid quantization', async () => {
      await expect(
        engine.loadModel({ model: 'llama-3-8b', quantization: 'int16' as any })
      ).rejects.toThrow(/Validation error on field 'quantization'/);
    });

    it('should accept valid model options', async () => {
      const handle = await engine.loadModel({
        model: 'llama-3-8b',
        quantization: 'int4',
      });
      expect(handle.id).toBe('llama-3-8b');
    });

    it('should accept string model identifier', async () => {
      const handle = await engine.loadModel('llama-3-8b');
      expect(handle.id).toBe('llama-3-8b');
    });
  });

  describe('createGenerator() validation', () => {
    it('should reject empty model', async () => {
      expect(() =>
        engine.createGenerator({ model: '', prompt: 'Hello' })
      ).toThrow(/Validation error on field 'model'/);
    });

    it('should reject maxTokens > 100000', async () => {
      expect(() =>
        engine.createGenerator({
          model: 'llama-3-8b',
          prompt: 'Hello',
          maxTokens: 200000,
        })
      ).toThrow(/Validation error on field 'maxTokens'/);
    });

    it('should reject temperature > 2', async () => {
      expect(() =>
        engine.createGenerator({
          model: 'llama-3-8b',
          prompt: 'Hello',
          temperature: 3,
        })
      ).toThrow(/Validation error on field 'temperature'/);
    });

    it('should reject topP > 1', async () => {
      expect(() =>
        engine.createGenerator({
          model: 'llama-3-8b',
          prompt: 'Hello',
          topP: 1.5,
        })
      ).toThrow(/Validation error on field 'topP'/);
    });

    it('should reject structured without schema', async () => {
      expect(() =>
        engine.createGenerator({
          model: 'llama-3-8b',
          prompt: 'Hello',
          structured: { format: 'json' } as any,
        })
      ).toThrow(/structured\.schema.*required/);
    });

    it('should accept valid generator params', async () => {
      const generator = engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello world',
        maxTokens: 100,
        temperature: 0.7,
        topP: 0.9,
      });
      expect(generator).toBeDefined();
    });
  });

  describe('tokenize() validation', () => {
    it('should reject empty model', async () => {
      await expect(
        engine.tokenize({ model: '', text: 'Hello' })
      ).rejects.toThrow(/Validation error on field 'model'/);
    });

    it('should accept valid tokenize request', async () => {
      const result = await engine.tokenize({
        model: 'llama-3-8b',
        text: 'Hello world',
      });
      expect(result.tokens).toBeDefined();
    });

    it('should accept empty text (valid for tokenization)', async () => {
      const result = await engine.tokenize({
        model: 'llama-3-8b',
        text: '',
      });
      expect(result.tokens).toEqual([]);
    });
  });

  describe('Error message quality', () => {
    it('should include field name in error message', async () => {
      await expect(
        engine.loadModel({ model: '' })
      ).rejects.toThrow(/field 'model'/);
    });

    it('should include validation details', async () => {
      try {
        await engine.loadModel({ model: '' });
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe('InvalidParams');
        expect(error.details).toBeDefined();
        expect(error.details.field).toBe('model');
        expect(error.details.issues).toBeDefined();
      }
    });

    it('should provide actionable error messages', async () => {
      await expect(
        engine.createGenerator({ model: 'llama-3-8b', prompt: 'Hi', maxTokens: -10 })
      ).rejects.toThrow(/Must be a positive integer/);
    });
  });

  describe('Passthrough mode', () => {
    it('should allow extra fields for mlx-engine compatibility', async () => {
      const handle = await engine.loadModel({
        model: 'llama-3-8b',
        customParam: 'value', // Not in schema, but allowed via .passthrough()
      } as any);
      expect(handle.id).toBe('llama-3-8b');
    });

    it('should allow extra kwargs in generator params', async () => {
      const generator = engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello',
        customSamplingParam: 0.5,
      } as any);
      expect(generator).toBeDefined();
    });
  });
});
```

**Total:** ~300 lines

#### Afternoon: Config & Event Validation Tests (3 hours)

**File:** `tests/integration/config-validation.test.ts` (~200 lines)

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from '@/config/loader.js';
import type { Config } from '@/config/loader.js';

describe('Config Validation Integration', () => {
  it('should reject missing batch_queue section', () => {
    expect(() =>
      validateConfig({} as Config)
    ).toThrow(/Validation error on field 'batch_queue'/);
  });

  it('should reject invalid max_batch_size', () => {
    expect(() =>
      validateConfig({
        batch_queue: { enabled: true, max_batch_size: -10 },
      } as any)
    ).toThrow(/max_batch_size/);
  });

  it('should accept valid config', () => {
    const config: Config = {
      batch_queue: {
        enabled: true,
        max_batch_size: 32,
        flush_interval_ms: 10,
      },
      // ... other required sections
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should load valid YAML config', () => {
    const config = loadConfig('./config/runtime.yaml');
    expect(config).toBeDefined();
    expect(config.batch_queue).toBeDefined();
  });
});
```

**File:** `tests/integration/event-validation.test.ts` (~200 lines)

```typescript
import { describe, it, expect } from 'vitest';
import { EngineEventEmitter } from '@/api/events.js';
import type { ModelLoadedEvent } from '@/api/events.js';

describe('Event Validation Integration', () => {
  let emitter: EngineEventEmitter;

  beforeEach(() => {
    emitter = new EngineEventEmitter();
  });

  describe('ModelLoadedEvent validation', () => {
    it('should reject empty model', () => {
      expect(() =>
        emitter.emitModelLoaded({ model: '', modelPath: '/path' } as any)
      ).toThrow(/Validation error on field 'model'/);
    });

    it('should reject invalid quantization', () => {
      expect(() =>
        emitter.emitModelLoaded({
          model: 'llama-3-8b',
          modelPath: '/path',
          quantization: 'int16',
        } as any)
      ).toThrow(/quantization/);
    });

    it('should accept valid event', () => {
      expect(() =>
        emitter.emitModelLoaded({
          model: 'llama-3-8b',
          modelPath: '/models/llama-3-8b',
          quantization: 'int4',
        })
      ).not.toThrow();
    });
  });

  // ... tests for all 8 event types
});
```

**Total:** ~500 lines of integration tests

---

### Day 4: Performance Validation (5 hours)

#### Morning: Performance Benchmarks (3 hours)

**File:** `tests/performance/validation-overhead.test.ts` (~200 lines)

**Goal:** Ensure Zod validation adds < 5% overhead

```typescript
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { LoadModelOptionsSchema } from '@/types/schemas/index.js';
import { validateLoadModelOptions } from '@/api/validators.js';
import type { LoadModelOptions } from '@/types/index.js';

describe('Validation Performance', () => {
  const validOptions: LoadModelOptions = {
    model: 'llama-3-8b',
    quantization: 'int4',
    revision: 'main',
    trustRemoteCode: false,
  };

  const iterations = 10000;

  it('should benchmark Zod validation', () => {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      LoadModelOptionsSchema.safeParse(validOptions);
    }
    const end = performance.now();
    const zodTime = end - start;

    console.log(`Zod validation: ${zodTime.toFixed(2)}ms for ${iterations} iterations`);
    console.log(`Average: ${(zodTime / iterations).toFixed(4)}ms per validation`);

    // Zod should validate in < 0.1ms per call
    expect(zodTime / iterations).toBeLessThan(0.1);
  });

  it('should benchmark manual validation', () => {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateLoadModelOptions(validOptions);
    }
    const end = performance.now();
    const manualTime = end - start;

    console.log(`Manual validation: ${manualTime.toFixed(2)}ms for ${iterations} iterations`);
    console.log(`Average: ${(manualTime / iterations).toFixed(4)}ms per validation`);
  });

  it('should compare Zod vs Manual validation overhead', () => {
    // Zod validation
    const zodStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      LoadModelOptionsSchema.safeParse(validOptions);
    }
    const zodEnd = performance.now();
    const zodTime = zodEnd - zodStart;

    // Manual validation
    const manualStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateLoadModelOptions(validOptions);
    }
    const manualEnd = performance.now();
    const manualTime = manualEnd - manualStart;

    const overhead = ((zodTime - manualTime) / manualTime) * 100;

    console.log(`Zod overhead: ${overhead.toFixed(2)}% vs manual validation`);

    // Zod overhead should be < 50% vs manual validation
    // (acceptable tradeoff for better type safety and error messages)
    expect(overhead).toBeLessThan(50);
  });

  it('should benchmark GeneratorParams validation', () => {
    const params = {
      model: 'llama-3-8b',
      prompt: 'Hello world',
      maxTokens: 100,
      temperature: 0.7,
      topP: 0.9,
    };

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      GeneratorParamsWithStructuredSchema.safeParse(params);
    }
    const end = performance.now();
    const time = end - start;

    console.log(`GeneratorParams validation: ${time.toFixed(2)}ms for ${iterations} iterations`);
    expect(time / iterations).toBeLessThan(0.15); // More complex schema, allow more time
  });
});

describe('Validation Error Performance', () => {
  it('should benchmark Zod error generation', () => {
    const invalidOptions = { model: '' };
    const iterations = 1000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const result = LoadModelOptionsSchema.safeParse(invalidOptions);
      if (!result.success) {
        zodErrorToEngineError(result.error);
      }
    }
    const end = performance.now();
    const time = end - start;

    console.log(`Zod error generation: ${time.toFixed(2)}ms for ${iterations} iterations`);
    // Error path can be slower (not hot path)
    expect(time / iterations).toBeLessThan(0.5);
  });
});
```

**Total:** ~200 lines

#### Afternoon: End-to-End Performance Tests (2 hours)

**File:** `tests/performance/e2e-validation.test.ts` (~150 lines)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Engine } from '@/api/engine.js';
import { performance } from 'node:perf_hooks';

describe('End-to-End Validation Performance', () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = new Engine({
      pythonPath: 'python3',
      runtimePath: './python/src',
    });
    await engine.start();
    // Warm up
    await engine.loadModel('llama-3-8b');
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  it('should measure loadModel() with validation overhead', async () => {
    const iterations = 100;
    const modelId = 'llama-3-8b';

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await engine.loadModel(modelId);
      await engine.unloadModel(modelId);
    }
    const end = performance.now();
    const totalTime = end - start;

    console.log(`loadModel() E2E: ${totalTime.toFixed(2)}ms for ${iterations} iterations`);
    console.log(`Average: ${(totalTime / iterations).toFixed(2)}ms per load`);

    // Validation should add < 1ms overhead (negligible compared to model loading time)
    // Model loading is 100-1000ms, so validation is < 1% overhead
  });

  it('should measure createGenerator() with validation overhead', () => {
    const iterations = 1000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const generator = engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello',
        maxTokens: 10,
      });
      // Don't consume generator, just measure creation overhead
    }
    const end = performance.now();
    const totalTime = end - start;

    console.log(`createGenerator() E2E: ${totalTime.toFixed(2)}ms for ${iterations} iterations`);
    console.log(`Average: ${(totalTime / iterations).toFixed(2)}ms per creation`);

    // Generator creation with validation should be < 1ms
    expect(totalTime / iterations).toBeLessThan(1);
  });
});
```

**Total:** ~150 lines

---

### Day 5: Contract Tests & Documentation (4 hours)

#### Morning: Contract Tests (3 hours)

**File:** `tests/contract/kr-serve-mlx-compat.test.ts` (~250 lines)

**Goal:** Ensure mlx-serving is 100% compatible with kr-serve-mlx v1.4.2

```typescript
import { describe, it, expect } from 'vitest';
import { Engine } from '@/api/engine.js';
import type { LoadModelOptions, GeneratorParams } from '@/types/index.js';

/**
 * Contract tests to ensure mlx-serving maintains 100% API compatibility
 * with kr-serve-mlx v1.4.2.
 *
 * These tests validate that all kr-serve-mlx v1.4.2 API calls work unchanged
 * with mlx-serving's Zod validation.
 */
describe('kr-serve-mlx v1.4.2 Contract Tests', () => {
  describe('loadModel() compatibility', () => {
    it('should accept kr-serve-mlx string model identifier', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();

      // kr-serve-mlx v1.4.2 API call
      const handle = await engine.loadModel('llama-3-8b');

      expect(handle.id).toBe('llama-3-8b');
      await engine.shutdown();
    });

    it('should accept kr-serve-mlx ModelDescriptor', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();

      // kr-serve-mlx v1.4.2 API call
      const handle = await engine.loadModel({
        id: 'llama-3-8b',
        path: 'mlx-community/Llama-3-8B-Instruct-4bit',
        quantization: 'int4',
      });

      expect(handle.id).toBe('llama-3-8b');
      await engine.shutdown();
    });

    it('should accept kr-serve-mlx extra kwargs (passthrough)', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();

      // kr-serve-mlx v1.4.2 API call with custom mlx-engine kwargs
      const handle = await engine.loadModel({
        model: 'llama-3-8b',
        custom_mlx_param: 'value', // Not in TypeScript types, but mlx-engine accepts it
      } as any);

      expect(handle.id).toBe('llama-3-8b');
      await engine.shutdown();
    });
  });

  describe('createGenerator() compatibility', () => {
    it('should accept kr-serve-mlx generator params', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();
      await engine.loadModel('llama-3-8b');

      // kr-serve-mlx v1.4.2 API call
      const generator = engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Hello world',
        maxTokens: 100,
        temperature: 0.7,
        topP: 0.9,
      });

      expect(generator).toBeDefined();
      await engine.shutdown();
    });

    it('should accept kr-serve-mlx structured output', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();
      await engine.loadModel('llama-3-8b');

      // kr-serve-mlx v1.4.2 API call
      const generator = engine.createGenerator({
        model: 'llama-3-8b',
        prompt: 'Generate a person',
        structured: {
          schema: { type: 'object', properties: { name: { type: 'string' } } },
          format: 'json',
        },
      });

      expect(generator).toBeDefined();
      await engine.shutdown();
    });
  });

  describe('Error compatibility', () => {
    it('should maintain kr-serve-mlx error format', async () => {
      const engine = new Engine({ pythonPath: 'python3', runtimePath: './python/src' });
      await engine.start();

      try {
        await engine.loadModel({ model: '' } as any);
        fail('Should have thrown');
      } catch (error: any) {
        // kr-serve-mlx v1.4.2 error shape
        expect(error.code).toBeDefined();
        expect(error.message).toBeDefined();
        expect(error.code).toBe('InvalidParams');
      }

      await engine.shutdown();
    });
  });
});
```

**Total:** ~250 lines

#### Afternoon: Completion Report (1 hour)

**File:** `automatosx/PRD/PHASE1_WEEK5_COMPLETION_REPORT.md`

**Sections:**
- Executive summary
- Integration completed (7 methods)
- Test results (integration, performance, contract)
- Code statistics
- Migration notes (manual validators deprecated)
- Next steps (Week 6)

---

## Code Statistics

### Modified Files (150 lines)

| File | Change | Description |
|------|--------|-------------|
| `src/api/engine.ts` | +80 lines | Zod validation in 7 methods |
| `src/config/loader.ts` | +10 lines | RuntimeConfigSchema integration |
| `src/types/schemas/model.ts` | +30 lines | VisionModelOptionsSchema |
| `src/types/schemas/generator.ts` | +30 lines | VisionGeneratorParamsSchema |

### New Test Files (1100 lines)

| File | Lines | Description |
|------|-------|-------------|
| `tests/integration/zod-validation.test.ts` | 300 | Engine method validation tests |
| `tests/integration/config-validation.test.ts` | 200 | Config validation tests |
| `tests/integration/event-validation.test.ts` | 200 | Event validation tests |
| `tests/performance/validation-overhead.test.ts` | 200 | Performance benchmarks |
| `tests/performance/e2e-validation.test.ts` | 150 | E2E performance tests |
| `tests/contract/kr-serve-mlx-compat.test.ts` | 250 | Contract tests |

### Documentation (40 pages)

| File | Pages | Description |
|------|-------|-------------|
| `PHASE1_WEEK5_PLAN.md` | 30 | This document |
| `PHASE1_WEEK5_SUMMARY.md` | 10 | Executive summary (to be created) |
| `PHASE1_WEEK5_COMPLETION_REPORT.md` | 15 | Completion report (created Day 5) |

**Total:** 150 lines of integration code, 1100 lines of tests, 40 pages of documentation

---

## Success Criteria

### Must Have ✅

- [ ] 7 Engine methods use Zod validation (loadModel, loadDraftModel, createGenerator, tokenize, loadVisionModel, createVisionGenerator, warmupModel)
- [ ] RuntimeConfigSchema integrated into config loader
- [ ] TelemetryConfig and event validation integrated (from Week 4)
- [ ] ≥300 integration tests (zod-validation.test.ts)
- [ ] Performance validation (< 5% overhead)
- [ ] Contract tests (100% kr-serve-mlx v1.4.2 compatibility)
- [ ] 473+ tests passing (373 baseline + 100 new)
- [ ] npm run build succeeds (ESM + CJS + DTS)
- [ ] npm run typecheck passes
- [ ] Completion report created

### Nice to Have

- [ ] Manual validators marked as deprecated (JSDoc @deprecated)
- [ ] Performance comparison table (Zod vs manual)
- [ ] Coverage report (≥95% for validation code paths)

---

## Timeline

| Day | Focus | Hours | Deliverables |
|-----|-------|-------|--------------|
| **Day 1** | Engine integration | 6 | Zod in 7 core methods |
| **Day 2** | Config & advanced methods | 5 | Config validation, vision methods |
| **Day 3** | Integration tests | 6 | 700 lines of integration tests |
| **Day 4** | Performance validation | 5 | Benchmarks, E2E tests |
| **Day 5** | Contract tests + docs | 4 | Contract tests, completion report |

**Total:** 26 hours over 5 days

---

## Risk Assessment

### LOW Risk ✅

1. **Schemas Already Exist**
   - Weeks 1-4 created all schemas
   - Just need to integrate (call .safeParse())
   - Integration pattern established in Week 2

2. **Clear Integration Points**
   - 7 methods with complex params
   - All in engine.ts (single file)
   - No refactoring required

3. **Backward Compatibility**
   - Keeping manual validators (deprecated)
   - .passthrough() ensures extra fields allowed
   - Contract tests verify no breaking changes

### MEDIUM Risk ⚠️

1. **Performance Overhead**
   - **Concern:** Zod validation may add latency
   - **Mitigation:** Benchmark with performance tests, ensure < 5% overhead
   - **Fallback:** Make validation optional via config flag (not recommended)

2. **Week 2 Dependency**
   - **Concern:** Week 5 assumes Week 2 completed (TS errors fixed)
   - **Mitigation:** If Week 2 not done, fix TS errors first (2-3 hours)
   - **Impact:** May delay Week 5 start by 1 day

3. **Vision Schema Gaps**
   - **Concern:** VisionModelOptions and VisionGeneratorParams not in Weeks 1-4
   - **Mitigation:** Create minimal schemas on Day 1 (~60 lines)
   - **Impact:** Low - similar to existing schemas

---

## Dependencies

### Completed ✅

- Zod v3.22.4 installed (Week 1)
- zodErrorToEngineError converter (Week 1)
- All core schemas (Weeks 1-4)
- Schema test patterns (Weeks 1-2)

### Required for Week 5

- **Week 2 completion** - TypeScript errors fixed, Zod integrated in 4 methods
- **Week 3 completion** - RuntimeConfigSchema created
- **Week 4 completion** - TelemetryConfig and event schemas created

### Blocked By

- **Week 2 not done:** If Week 2 incomplete, must fix TS errors first
- **Schemas missing:** If Week 3/4 not done, must create schemas first

---

## What Comes After Week 5

### Week 6: Documentation & Testing (Final Week)

**Focus:** Complete Phase 1 with documentation and final validation

**Deliverables:**
1. **docs/ZOD_SCHEMAS.md** - Comprehensive guide to using Zod schemas
2. **API Reference** - Update with schema exports
3. **Migration Guide** - Manual validators → Zod migration path
4. **README Updates** - Add Zod validation examples
5. **Final Validation** - Full test suite, coverage report, signoff

**Timeline:** 3 days (15 hours)

---

## Migration Strategy: Manual Validators → Zod

### Current State (Manual Validators)

```typescript
// src/api/validators.ts
export function validateLoadModelOptions(options: LoadModelOptions): ValidationResult {
  const errors: string[] = [];
  if (!options.model) errors.push('model is required');
  // ... 50+ lines
  return { valid: errors.length === 0, errors };
}
```

### Target State (Zod Validators)

```typescript
// src/types/schemas/model.ts
export const LoadModelOptionsSchema = z.object({
  model: NonEmptyString,
  // ... schema definition
}).passthrough();

// src/api/engine.ts
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }
  // ... implementation
}
```

### Migration Path

**Phase 1 (Week 5):** Add Zod validation alongside manual validators
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // NEW: Zod validation (Phase 1 Week 5)
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // OLD: Manual normalization (keep for now)
  const normalizedOptions = normalizeLoadModelOptions(options);
  if (!normalizedOptions) {
    throw new EngineClientError('InvalidParams', 'Invalid model options');
  }

  // ... rest
}
```

**Phase 2 (v1.0.0):** Remove manual validators
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  // Only Zod validation
  const parseResult = LoadModelOptionsSchema.safeParse(options);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest (no manual validation)
}
```

**Deprecation Notice:**
```typescript
/**
 * Validate LoadModelOptions parameters.
 *
 * @deprecated Use LoadModelOptionsSchema.safeParse() instead
 * @see {@link ../types/schemas/model.ts!LoadModelOptionsSchema}
 */
export function validateLoadModelOptions(options: LoadModelOptions): ValidationResult {
  // ... implementation (kept for backward compatibility)
}
```

---

## Bottom Line

Phase 1 Week 5 **completes the Zod integration** across all Engine API methods:

- ✅ 7 methods with Zod validation (loadModel, createGenerator, tokenize, etc.)
- ✅ RuntimeConfigSchema integrated into config loader
- ✅ Comprehensive integration tests (~700 lines)
- ✅ Performance validation (< 5% overhead)
- ✅ Contract tests (100% kr-serve-mlx compatibility)
- ✅ Timeline: 5 days (26 hours)
- ✅ Risk: LOW (schemas exist, clear integration points)

**After Week 5:** All Zod validation complete. Week 6 focuses on documentation and final signoff for Phase 1.

---

<div align="center">

**Phase 1 Week 5 Status: READY TO START**

Integration & Error Handling | 5 Days | 26 Hours | LOW Risk

Complete Zod integration for all Engine API methods + comprehensive tests

</div>
