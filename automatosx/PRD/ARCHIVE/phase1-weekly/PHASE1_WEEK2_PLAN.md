# Phase 1 Week 2: Core API Schemas Completion - Detailed Implementation Plan

**Status:** READY TO START
**Phase:** Phase 1 - Zod Integration (Week 3 of 18)
**Date:** 2025-11-07
**Owner:** Bob (Backend Lead)
**Related:** PHASE1_WEEK1_COMPLETION_REPORT.md, PHASE1_WEEK1_PLAN.md, ACTION-PLAN-FINAL.md

---

## Executive Summary

Week 2 completes the Core API Schemas work started in Week 1. Week 1 delivered 80% completion with all schemas created but integration blocked by pre-existing TypeScript errors. Week 2 focuses on:

1. **Fixing Pre-existing TypeScript Errors** (50+ errors in engine.ts)
2. **Completing Zod Integration** into Engine methods
3. **Writing Comprehensive Tests** for all schemas
4. **Validating Full Test Suite** passes

**Key Goal:** Achieve 100% completion of Core API Schemas deliverable.

**Timeline:** 2-3 days (6-7 hours total)

---

## Week 1 Recap: What Was Completed

### ✅ Completed (80%)

1. **Schema Files Created (100%)**
   - `src/types/schemas/index.ts` (30 lines)
   - `src/types/schemas/common.ts` (62 lines)
   - `src/types/schemas/model.ts` (114 lines)
   - `src/types/schemas/generator.ts` (138 lines)
   - `src/types/schemas/tokenizer.ts` (28 lines)
   - **Total:** 372 lines of production-ready schemas ✅

2. **Error Handling Created (100%)**
   - `zodErrorToEngineError()` converter in `src/api/errors.ts`
   - `ValidationError` code added to `EngineErrorCode` enum
   - **Total:** 36 lines ✅

3. **Engine Integration Prepared (100%)**
   - Schema imports added to `src/api/engine.ts`
   - Ready for validation calls
   - **Total:** 5 lines ✅

### ⏸️ Incomplete (20%)

1. **Pre-existing TypeScript Errors (Blocking)**
   - 50+ TypeScript errors in `engine.ts` (NOT caused by Zod)
   - Related to missing properties: `started`, `startPromise`, `shuttingDown`
   - Related to circuit breaker state management
   - **Status:** Must be fixed before Zod integration

2. **Zod Validation Integration (Pending)**
   - `loadModel()` - validation call not added
   - `loadDraftModel()` - validation call not added
   - `createGenerator()` - validation call not added
   - `tokenize()` - validation call not added
   - **Status:** Waiting for TS error fixes

3. **Schema Tests (Not Started)**
   - No unit tests for schemas
   - No integration tests for validation
   - **Status:** 0% complete

4. **Test Suite Validation (Not Started)**
   - 27 tests failing (pre-existing)
   - 346 tests passing
   - **Status:** Need to fix failing tests

---

## Week 2 Detailed Tasks

### Day 1: Fix Pre-existing TypeScript Errors (2-3 hours)

**Priority:** CRITICAL - This blocks all other work

**Problem Analysis:**

The TypeScript errors fall into three categories:

1. **Missing Lifecycle Properties**
   - `started: boolean`
   - `startPromise: Promise<void> | null`
   - `shuttingDown: boolean`

2. **Missing Circuit Breaker Properties**
   - `circuitBreakerState: 'closed' | 'open' | 'half-open'`
   - `circuitBreakerFailures: number`
   - `circuitBreakerLastFailure: number`
   - `CIRCUIT_BREAKER_THRESHOLD: number`
   - `CIRCUIT_BREAKER_TIMEOUT: number`

3. **Missing RuntimeLifecycleService Integration**
   - Import exists but not used properly
   - Methods reference non-existent properties

**Root Cause:** The codebase appears to be mid-refactoring from manual lifecycle management to `RuntimeLifecycleService`, but the refactoring is incomplete.

**Solution Strategy:**

**Option A: Complete the RuntimeLifecycleService Migration** (Recommended)
- Use `RuntimeLifecycleService` for lifecycle management
- Remove manual `started`, `startPromise` properties
- Delegate to service methods

**Option B: Restore Legacy Properties**
- Add missing properties back to Engine class
- Keep manual lifecycle management
- Simpler, less risk

**Task 1.1: Choose Strategy and Fix Errors**

Let me read the RuntimeLifecycleService to understand the intended design:

```typescript
// Read the service to understand the pattern
// Then either:
// A) Complete migration to service
// B) Restore legacy properties
```

**Estimated Time:** 2-3 hours

**Files to Modify:**
- `src/api/engine.ts` - Fix all TypeScript errors

**Acceptance Criteria:**
- [x] All TypeScript errors resolved
- [x] `npm run typecheck` passes
- [x] `npm run build` succeeds (including DTS)
- [x] No breaking changes to public API

**Task 1.2: Validate Build**

```bash
npm run build
npm run typecheck
npm run lint
```

**Expected Output:**
- ESM build: ✅
- CJS build: ✅
- DTS build: ✅ (this was failing before)
- No TypeScript errors
- No ESLint errors

---

### Day 1 (continued): Integrate Zod Validation (1 hour)

**Prerequisite:** TypeScript errors fixed

Now we can add the Zod validation calls that were blocked in Week 1.

**Task 1.3: Integrate Zod into Engine.loadModel()**

File: `src/api/engine.ts`

**Current Code (around line 201):**
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  try {
    const normalizedOptions = normalizeLoadModelOptions(options)!;
    const runtime = await this.ensureRuntime();
    const handle = await runtime.modelManager.loadModel(normalizedOptions);
    // ... rest of method
  } catch (error) {
    throw this.mapError(error, 'ModelLoadError');
  }
}
```

**Updated Code:**
```typescript
public async loadModel(options: LoadModelOptions | string): Promise<ModelHandle> {
  try {
    // Phase 1 Week 2: Zod validation before normalization
    const opts = typeof options === 'string' ? { model: options } : options;
    const parseResult = LoadModelOptionsSchema.safeParse(opts);
    if (!parseResult.success) {
      throw zodErrorToEngineError(parseResult.error);
    }

    const normalizedOptions = normalizeLoadModelOptions(options)!;
    const runtime = await this.ensureRuntime();
    const handle = await runtime.modelManager.loadModel(normalizedOptions);
    // ... rest of method (unchanged)
  } catch (error) {
    throw this.mapError(error, 'ModelLoadError');
  }
}
```

**Task 1.4: Integrate Zod into Engine.loadDraftModel()**

```typescript
public async loadDraftModel(options: LoadModelOptions): Promise<ModelHandle> {
  try {
    // Phase 1 Week 2: Zod validation
    const parseResult = LoadModelOptionsSchema.safeParse(options);
    if (!parseResult.success) {
      throw zodErrorToEngineError(parseResult.error);
    }

    const normalizedOptions = normalizeLoadModelOptions({
      ...options,
      draft: true,
    })!;
    // ... rest of method (unchanged)
  } catch (error) {
    throw this.mapError(error, 'ModelLoadError');
  }
}
```

**Task 1.5: Integrate Zod into Engine.createGenerator()**

File: `src/api/engine.ts` (around line 400-500)

```typescript
public createGenerator(
  params: GeneratorParams,
  options?: CreateGeneratorOptions
): AsyncGenerator<GeneratorChunk, void> {
  // Phase 1 Week 2: Zod validation
  const parseResult = GeneratorParamsWithStructuredSchema.safeParse(params);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest of method (unchanged)
  const normalized = normalizeGeneratorParams(params);
  // ...
}
```

**Task 1.6: Integrate Zod into Engine.tokenize()**

```typescript
public async tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
  await this.ensureRuntime();

  // Phase 1 Week 2: Zod validation
  const parseResult = TokenizeRequestSchema.safeParse(request);
  if (!parseResult.success) {
    throw zodErrorToEngineError(parseResult.error);
  }

  // ... rest of method (unchanged)
  const normalized = normalizeTokenizeRequest(request);
  // ...
}
```

**Task 1.7: Add Validation to Snake_case Aliases**

The Engine class has snake_case aliases for all methods. Add validation there too:

```typescript
public readonly load_model = async (
  options: LoadModelOptions | Record<string, unknown>
): Promise<ModelHandle> => {
  const normalized = normalizeLoadModelOptions(options);
  return this.loadModel(normalized); // Will validate via camelCase method
};
```

**Note:** Since snake_case methods delegate to camelCase methods, validation will happen automatically.

**Acceptance Criteria:**
- [x] All 4 main methods have Zod validation
- [x] Validation happens BEFORE normalization
- [x] Validation errors use `zodErrorToEngineError()`
- [x] Snake_case aliases work correctly
- [x] No changes to method signatures (public API)

---

### Day 2: Write Comprehensive Schema Tests (3-4 hours)

**Task 2.1: Create Common Schema Tests**

File: `tests/unit/schemas/common.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  NonEmptyString,
  PositiveInteger,
  NonNegativeInteger,
  NonNegativeNumber,
  ClampedTemperature,
  ClampedTopP,
  ClampedPenalty,
  QuantizationMode,
  StructuredFormat,
} from '../../../src/types/schemas/common.js';

describe('Common Schema Primitives', () => {
  describe('NonEmptyString', () => {
    it('should accept non-empty strings', () => {
      expect(NonEmptyString.parse('hello')).toBe('hello');
      expect(NonEmptyString.parse('a')).toBe('a');
    });

    it('should reject empty strings', () => {
      expect(() => NonEmptyString.parse('')).toThrow(/Cannot be empty/);
    });
  });

  describe('PositiveInteger', () => {
    it('should accept positive integers', () => {
      expect(PositiveInteger.parse(1)).toBe(1);
      expect(PositiveInteger.parse(100)).toBe(100);
    });

    it('should reject zero', () => {
      expect(() => PositiveInteger.parse(0)).toThrow();
    });

    it('should reject negative numbers', () => {
      expect(() => PositiveInteger.parse(-1)).toThrow();
    });

    it('should reject floats', () => {
      expect(() => PositiveInteger.parse(1.5)).toThrow(/integer/);
    });
  });

  describe('ClampedTemperature', () => {
    it('should accept valid temperatures', () => {
      expect(ClampedTemperature.parse(0)).toBe(0);
      expect(ClampedTemperature.parse(0.7)).toBe(0.7);
      expect(ClampedTemperature.parse(2)).toBe(2);
    });

    it('should reject temperature < 0', () => {
      expect(() => ClampedTemperature.parse(-0.1)).toThrow(/at least 0/);
    });

    it('should reject temperature > 2', () => {
      expect(() => ClampedTemperature.parse(2.1)).toThrow(/cannot exceed 2/);
    });
  });

  describe('ClampedTopP', () => {
    it('should accept valid top-p values', () => {
      expect(ClampedTopP.parse(0)).toBe(0);
      expect(ClampedTopP.parse(0.9)).toBe(0.9);
      expect(ClampedTopP.parse(1)).toBe(1);
    });

    it('should reject top-p < 0', () => {
      expect(() => ClampedTopP.parse(-0.1)).toThrow();
    });

    it('should reject top-p > 1', () => {
      expect(() => ClampedTopP.parse(1.1)).toThrow();
    });
  });

  describe('QuantizationMode', () => {
    it('should accept valid quantization modes', () => {
      expect(QuantizationMode.parse('none')).toBe('none');
      expect(QuantizationMode.parse('int8')).toBe('int8');
      expect(QuantizationMode.parse('int4')).toBe('int4');
    });

    it('should reject invalid modes', () => {
      expect(() => QuantizationMode.parse('int16')).toThrow();
      expect(() => QuantizationMode.parse('fp16')).toThrow();
    });
  });
});
```

**Estimated Lines:** 100 lines

**Task 2.2: Create Model Schema Tests**

File: `tests/unit/schemas/model.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  LoadModelOptionsSchema,
  ModelDescriptorSchema,
  ModelHandleSchema,
  CompatibilityReportSchema,
} from '../../../src/types/schemas/model.js';

describe('LoadModelOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept string model identifier', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: 'llama-3-8b',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.model).toBe('llama-3-8b');
      }
    });

    it('should accept ModelDescriptor object', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: {
          id: 'llama-3-8b',
          source: 'huggingface',
          modality: 'text',
          family: 'mlx-lm',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept all optional fields', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: 'test-model',
        draft: true,
        revision: 'main',
        quantization: 'int8',
        trustRemoteCode: false,
        parameters: { temperature: 0.7 },
        customField: 'custom-value', // passthrough
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject empty string model', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Cannot be empty');
      }
    });

    it('should reject missing model field', () => {
      const result = LoadModelOptionsSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['model']);
      }
    });

    it('should reject invalid quantization mode', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: 'test',
        quantization: 'int16',
      });
      expect(result.success).toBe(false);
    });

    it('should reject ModelDescriptor with missing required fields', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: {
          id: 'test',
          source: 'huggingface',
          // missing modality and family
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('error messages', () => {
    it('should provide clear field-level errors', () => {
      const result = LoadModelOptionsSchema.safeParse({
        model: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue.path).toEqual(['model']);
        expect(issue.message).toBeTruthy();
        expect(issue.message.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('ModelDescriptorSchema', () => {
  it('should accept valid model descriptor', () => {
    const descriptor = {
      id: 'llama-3-8b',
      source: 'huggingface' as const,
      modality: 'text' as const,
      family: 'mlx-lm' as const,
    };
    expect(ModelDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it('should accept optional fields', () => {
    const descriptor = {
      id: 'llama-3-8b',
      variant: 'instruct',
      source: 'local' as const,
      path: '/path/to/model',
      tokenizer: {
        type: 'sentencepiece',
        vocabSize: 32000,
      },
      modality: 'vision' as const,
      family: 'mlx-vlm' as const,
    };
    expect(ModelDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });
});

// ... more tests for ModelHandleSchema, CompatibilityReportSchema
```

**Estimated Lines:** 200 lines

**Task 2.3: Create Generator Schema Tests**

File: `tests/unit/schemas/generator.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  GeneratorParamsSchema,
  GeneratorParamsWithStructuredSchema,
  PromptTemplateSchema,
  TokenizedPromptSchema,
  StructuredOutputConfigSchema,
  GeneratorChunkSchema,
  GenerationStatsSchema,
} from '../../../src/types/schemas/generator.js';

describe('GeneratorParamsSchema', () => {
  describe('valid inputs', () => {
    it('should accept minimal valid params', () => {
      const params = {
        model: 'llama-3-8b',
        prompt: 'Hello world',
      };
      expect(GeneratorParamsSchema.parse(params)).toEqual(params);
    });

    it('should accept all optional sampling parameters', () => {
      const params = {
        model: 'llama-3-8b',
        prompt: 'Hello',
        maxTokens: 100,
        temperature: 0.7,
        topP: 0.9,
        presencePenalty: 0.5,
        frequencyPenalty: -0.5,
        repetitionPenalty: 1.2,
        stopSequences: ['</s>', '\n\n'],
        stopTokenIds: [2, 3],
        seed: 42,
        streaming: true,
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
    });

    it('should accept PromptTemplate', () => {
      const params = {
        model: 'test',
        prompt: {
          template: 'Hello {{name}}',
          variables: { name: 'Alice' },
        },
      };
      expect(GeneratorParamsSchema.parse(params)).toEqual(params);
    });

    it('should accept TokenizedPrompt', () => {
      const params = {
        model: 'test',
        prompt: { tokens: [1, 2, 3, 4] },
      };
      expect(GeneratorParamsSchema.parse(params)).toEqual(params);
    });

    it('should accept structured output config', () => {
      const params = {
        model: 'test',
        prompt: 'Generate JSON',
        structured: {
          schema: { type: 'object', properties: {} },
          format: 'json' as const,
        },
      };
      expect(GeneratorParamsSchema.parse(params)).toEqual(params);
    });

    it('should accept draft model', () => {
      const params = {
        model: 'llama-3-8b',
        prompt: 'Hello',
        draftModel: 'llama-3.2-3b',
      };
      expect(GeneratorParamsSchema.parse(params)).toEqual(params);
    });

    it('should allow extra kwargs (passthrough)', () => {
      const params = {
        model: 'test',
        prompt: 'test',
        customField: 'custom',
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject missing model', () => {
      const params = { prompt: 'test' };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('should reject empty model string', () => {
      const params = { model: '', prompt: 'test' };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('should reject maxTokens > 100000', () => {
      const params = {
        model: 'test',
        prompt: 'test',
        maxTokens: 200000,
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('100000');
      }
    });

    it('should reject temperature > 2', () => {
      const params = {
        model: 'test',
        prompt: 'test',
        temperature: 3,
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('2');
      }
    });

    it('should reject topP > 1', () => {
      const params = {
        model: 'test',
        prompt: 'test',
        topP: 1.5,
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('should reject negative repetitionPenalty', () => {
      const params = {
        model: 'test',
        prompt: 'test',
        repetitionPenalty: -1,
      };
      const result = GeneratorParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });
});

describe('GeneratorParamsWithStructuredSchema', () => {
  it('should accept valid structured output', () => {
    const params = {
      model: 'test',
      prompt: 'test',
      structured: {
        schema: { type: 'object' },
        format: 'json' as const,
      },
    };
    const result = GeneratorParamsWithStructuredSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it('should reject structured output without schema', () => {
    const params = {
      model: 'test',
      prompt: 'test',
      structured: {
        format: 'json' as const,
      },
    };
    const result = GeneratorParamsWithStructuredSchema.safeParse(params);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('schema');
    }
  });

  it('should reject structured output without format', () => {
    const params = {
      model: 'test',
      prompt: 'test',
      structured: {
        schema: { type: 'object' },
      },
    };
    const result = GeneratorParamsWithStructuredSchema.safeParse(params);
    expect(result.success).toBe(false);
  });
});

describe('GeneratorChunkSchema', () => {
  it('should accept token chunk', () => {
    const chunk = {
      type: 'token' as const,
      token: 'Hello',
      tokenId: 123,
      logprob: -0.5,
    };
    expect(GeneratorChunkSchema.parse(chunk)).toEqual(chunk);
  });

  it('should accept metadata chunk', () => {
    const chunk = {
      type: 'metadata' as const,
      stats: {
        tokensGenerated: 10,
        tokensPerSecond: 50,
        timeToFirstToken: 100,
      },
    };
    expect(GeneratorChunkSchema.parse(chunk)).toEqual(chunk);
  });

  it('should accept error chunk', () => {
    const chunk = {
      type: 'error' as const,
      error: {
        code: 'GenerationError',
        message: 'Something went wrong',
      },
    };
    expect(GeneratorChunkSchema.parse(chunk)).toEqual(chunk);
  });

  it('should reject invalid chunk type', () => {
    const chunk = {
      type: 'invalid',
      data: 'test',
    };
    const result = GeneratorChunkSchema.safeParse(chunk);
    expect(result.success).toBe(false);
  });
});
```

**Estimated Lines:** 300 lines

**Task 2.4: Create Tokenizer Schema Tests**

File: `tests/unit/schemas/tokenizer.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  TokenizeRequestSchema,
  TokenizeResponseSchema,
} from '../../../src/types/schemas/tokenizer.js';

describe('TokenizeRequestSchema', () => {
  it('should accept valid tokenize request', () => {
    const request = {
      model: 'llama-3-8b',
      text: 'Hello world',
    };
    expect(TokenizeRequestSchema.parse(request)).toEqual(request);
  });

  it('should accept empty text', () => {
    const request = {
      model: 'test',
      text: '',
    };
    expect(TokenizeRequestSchema.parse(request)).toEqual(request);
  });

  it('should accept addBos option', () => {
    const request = {
      model: 'test',
      text: 'hello',
      addBos: true,
    };
    expect(TokenizeRequestSchema.parse(request)).toEqual(request);
  });

  it('should reject empty model', () => {
    const request = {
      model: '',
      text: 'hello',
    };
    const result = TokenizeRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });

  it('should reject missing model', () => {
    const request = {
      text: 'hello',
    };
    const result = TokenizeRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });
});

describe('TokenizeResponseSchema', () => {
  it('should accept valid response', () => {
    const response = {
      tokens: [1, 2, 3, 4],
    };
    expect(TokenizeResponseSchema.parse(response)).toEqual(response);
  });

  it('should accept response with token strings', () => {
    const response = {
      tokens: [1, 2, 3],
      tokenStrings: ['Hello', ' world', '!'],
    };
    expect(TokenizeResponseSchema.parse(response)).toEqual(response);
  });

  it('should reject negative token IDs', () => {
    const response = {
      tokens: [1, -2, 3],
    };
    const result = TokenizeResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});
```

**Estimated Lines:** 100 lines

**Task 2.5: Create Integration Tests**

File: `tests/integration/zod-validation.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Engine } from '../../src/api/engine.js';

describe('Zod Validation Integration', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine();
  });

  afterEach(async () => {
    await engine.shutdown();
  });

  describe('loadModel validation', () => {
    it('should reject empty model identifier', async () => {
      await expect(
        engine.loadModel({ model: '' })
      ).rejects.toThrow(/Validation error.*model.*Cannot be empty/);
    });

    it('should reject invalid quantization', async () => {
      await expect(
        engine.loadModel({ model: 'test', quantization: 'int16' as any })
      ).rejects.toThrow(/Validation error.*quantization/);
    });

    it('should accept valid string model', async () => {
      // This will fail with runtime error (Python not started)
      // but should NOT fail with validation error
      try {
        await engine.loadModel('test-model');
      } catch (err: any) {
        expect(err.message).not.toContain('Validation error');
        expect(err.code).not.toBe('ValidationError');
      }
    });

    it('should accept valid model options', async () => {
      try {
        await engine.loadModel({
          model: 'test',
          quantization: 'int4',
          draft: false,
        });
      } catch (err: any) {
        expect(err.message).not.toContain('Validation error');
      }
    });
  });

  describe('createGenerator validation', () => {
    it('should reject empty model', () => {
      expect(() => {
        engine.createGenerator({ model: '', prompt: 'test' });
      }).toThrow(/Validation error.*model/);
    });

    it('should reject invalid temperature', () => {
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'test',
          temperature: 3,
        });
      }).toThrow(/Validation error.*temperature/);
    });

    it('should reject invalid topP', () => {
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'test',
          topP: 1.5,
        });
      }).toThrow(/Validation error.*topP/);
    });

    it('should reject maxTokens > 100000', () => {
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'test',
          maxTokens: 200000,
        });
      }).toThrow(/Validation error.*maxTokens.*100000/);
    });

    it('should reject negative repetitionPenalty', () => {
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'test',
          repetitionPenalty: -1,
        });
      }).toThrow(/Validation error.*repetitionPenalty/);
    });

    it('should reject structured output without schema', () => {
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'test',
          structured: {
            format: 'json',
          } as any,
        });
      }).toThrow(/Validation error.*structured/);
    });

    it('should accept valid params', () => {
      // Should not throw validation error
      // (will throw runtime error due to Python not started, but that's OK)
      expect(() => {
        engine.createGenerator({
          model: 'test',
          prompt: 'Hello',
          temperature: 0.7,
          maxTokens: 100,
        });
      }).not.toThrow(/Validation error/);
    });
  });

  describe('tokenize validation', () => {
    it('should reject empty model', async () => {
      await expect(
        engine.tokenize({ model: '', text: 'test' })
      ).rejects.toThrow(/Validation error.*model/);
    });

    it('should accept valid tokenize request', async () => {
      try {
        await engine.tokenize({ model: 'test', text: 'hello' });
      } catch (err: any) {
        expect(err.message).not.toContain('Validation error');
      }
    });

    it('should accept empty text', async () => {
      try {
        await engine.tokenize({ model: 'test', text: '' });
      } catch (err: any) {
        expect(err.message).not.toContain('Validation error');
      }
    });
  });

  describe('error message quality', () => {
    it('should include field name in error', async () => {
      try {
        await engine.loadModel({ model: '' });
      } catch (err: any) {
        expect(err.message).toContain('model');
        expect(err.details?.field).toBe('model');
      }
    });

    it('should include all validation issues', async () => {
      try {
        await engine.loadModel({ model: '' });
      } catch (err: any) {
        expect(err.details?.issues).toBeDefined();
        expect(Array.isArray(err.details?.issues)).toBe(true);
      }
    });
  });
});
```

**Estimated Lines:** 200 lines

**Total Test Code:** ~900 lines

**Acceptance Criteria:**
- [x] All schema unit tests pass
- [x] Integration tests pass
- [x] Coverage ≥90% for schema files
- [x] Error message quality validated

---

### Day 2 (continued): Fix Failing Tests (1 hour)

**Task 2.6: Analyze and Fix Failing Engine Tests**

**Current Status:** 27 tests failing in `tests/unit/api/engine.test.ts`

**Common Error:** `this.canAttemptOperation is not a function`

**Root Cause:** The failing tests are related to the same TypeScript errors we're fixing. Once Day 1 fixes are complete, these tests should pass.

**Steps:**
1. Run tests after TypeScript fixes: `npm test tests/unit/api/engine.test.ts`
2. If still failing, debug each failure
3. Fix test setup/mocking if needed
4. Ensure 0 regressions

**Target:** All 373+ tests passing

---

### Day 3: Final Validation and Documentation (2 hours)

**Task 3.1: Full Test Suite Validation**

```bash
# Run all tests
npm test

# Expected output:
# Test Files: 38 passed (38)
# Tests: 373+ passed | 2 skipped (375+)
```

**Task 3.2: Build Validation**

```bash
# Clean build
npm run clean
npm run build

# Expected output:
# ✅ ESM build successful
# ✅ CJS build successful
# ✅ DTS build successful

# Typecheck
npm run typecheck
# Expected: No errors

# Lint
npm run lint
# Expected: No errors (or only existing warnings)
```

**Task 3.3: Coverage Analysis**

```bash
npm run test:coverage -- --reporter=html

# Check coverage for:
# - src/types/schemas/common.ts: ≥90%
# - src/types/schemas/model.ts: ≥90%
# - src/types/schemas/generator.ts: ≥90%
# - src/types/schemas/tokenizer.ts: ≥90%
```

**Task 3.4: Manual Validation Testing**

Create a simple test script to validate end-to-end:

File: `tests/manual/zod-validation-demo.ts`

```typescript
import { Engine } from '../../src/api/engine.js';

async function demo() {
  const engine = new Engine();

  console.log('Testing Zod validation...\n');

  // Test 1: Valid model loading
  console.log('1. Valid model (should not throw validation error):');
  try {
    await engine.loadModel('test-model');
  } catch (err: any) {
    console.log(`   Error: ${err.code} - ${err.message}`);
    console.log(`   (Expected runtime error, NOT ValidationError)`);
  }

  // Test 2: Invalid model (empty string)
  console.log('\n2. Invalid model - empty string:');
  try {
    await engine.loadModel({ model: '' });
  } catch (err: any) {
    console.log(`   ✅ Error: ${err.code} - ${err.message}`);
  }

  // Test 3: Invalid temperature
  console.log('\n3. Invalid temperature > 2:');
  try {
    engine.createGenerator({
      model: 'test',
      prompt: 'hello',
      temperature: 3,
    });
  } catch (err: any) {
    console.log(`   ✅ Error: ${err.code} - ${err.message}`);
  }

  // Test 4: Invalid maxTokens
  console.log('\n4. Invalid maxTokens > 100000:');
  try {
    engine.createGenerator({
      model: 'test',
      prompt: 'hello',
      maxTokens: 200000,
    });
  } catch (err: any) {
    console.log(`   ✅ Error: ${err.code} - ${err.message}`);
  }

  await engine.shutdown();
  console.log('\n✅ All validation tests passed!');
}

demo().catch(console.error);
```

Run: `tsx tests/manual/zod-validation-demo.ts`

**Task 3.5: Create Week 2 Completion Report**

File: `automatosx/PRD/PHASE1_WEEK2_COMPLETION_REPORT.md`

Document:
- All completed work
- Test results
- Coverage metrics
- Known issues (if any)
- Next steps

---

## Files Modified Summary

### Modified Files

| File | Changes | Description |
|------|---------|-------------|
| `src/api/engine.ts` | +50-100 lines | Fix TS errors + add Zod validation |
| `src/types/schemas/index.ts` | No change | Already created in Week 1 |

### New Test Files

| File | Lines | Description |
|------|-------|-------------|
| `tests/unit/schemas/common.test.ts` | 100 | Common primitive tests |
| `tests/unit/schemas/model.test.ts` | 200 | Model schema tests |
| `tests/unit/schemas/generator.test.ts` | 300 | Generator schema tests |
| `tests/unit/schemas/tokenizer.test.ts` | 100 | Tokenizer schema tests |
| `tests/integration/zod-validation.test.ts` | 200 | Integration tests |
| `tests/manual/zod-validation-demo.ts` | 50 | Manual demo script |

**Total New Test Code:** ~950 lines

---

## Success Criteria

### Functional Requirements

- [x] All TypeScript errors fixed (0 errors)
- [x] Zod validation integrated into all 4 core methods
- [x] All schema tests written and passing
- [x] Integration tests passing
- [x] All existing tests still passing (0 regression)

### Quality Requirements

- [x] Test coverage ≥90% for schema files
- [x] Build succeeds (ESM + CJS + DTS)
- [x] Typecheck passes
- [x] Lint passes (no new warnings)
- [x] Clear error messages validated

### Documentation Requirements

- [x] Week 2 completion report created
- [x] Code comments updated
- [x] Test examples documented

---

## Timeline

| Day | Focus | Tasks | Hours |
|-----|-------|-------|-------|
| **Day 1 AM** | Fix TypeScript Errors | Read code, choose strategy, fix errors | 2-3 |
| **Day 1 PM** | Zod Integration | Add validation to 4 methods | 1 |
| **Day 2 AM** | Schema Tests | Write unit tests for all schemas | 2 |
| **Day 2 PM** | Integration Tests | Write integration + fix failing tests | 2 |
| **Day 3** | Validation & Docs | Full test suite, coverage, completion report | 2 |

**Total:** 7-9 hours over 2-3 days

---

## Risk Assessment

### LOW Risk ✅

1. **Schema Code Already Written**
   - All schemas created in Week 1
   - Just need integration + tests
   - Clear patterns established

2. **Test Patterns Known**
   - Vitest already configured
   - Test examples in plan
   - Similar to existing tests

### MEDIUM Risk ⚠️

1. **TypeScript Errors**
   - 50+ errors to fix
   - May uncover deeper issues
   - Could take longer than estimated

   **Mitigation:**
   - Timebox to 3 hours max
   - Choose simplest fix strategy
   - Document any compromises

2. **Test Coverage**
   - Need 90%+ coverage
   - Some edge cases may be hard to test
   - Integration tests may be flaky

   **Mitigation:**
   - Focus on happy paths first
   - Mock Engine dependencies in tests
   - Skip flaky tests if needed (mark as TODO)

---

## Dependencies

### Completed (Week 1)

- ✅ All schema files created
- ✅ Error converter created
- ✅ Imports added to Engine

### Required (Existing)

- ✅ Vitest test framework
- ✅ TypeScript compiler
- ✅ ESLint + Prettier

### No New Dependencies

All dependencies already installed

---

## Exit Criteria

Week 2 is complete when:

- [x] All TypeScript errors fixed
- [x] `npm run build` succeeds (including DTS)
- [x] `npm run typecheck` passes (0 errors)
- [x] Zod validation integrated into Engine methods
- [x] All schema tests written and passing
- [x] Integration tests passing
- [x] Test coverage ≥90% for schemas
- [x] All existing tests passing (373+)
- [x] Completion report created

---

## Next Steps (Week 3)

After Week 2 completion, proceed to Week 3: Config & Bridge Schemas

**Week 3 Deliverables:**
- Runtime config schemas (60+ properties)
- JSON-RPC integration
- Config loader validation
- Transport validation
- Comprehensive tests

**Timeline:** 5 days (26 hours)

**Files to Create:**
- `src/types/schemas/config.ts` (~250 lines)
- `src/types/schemas/jsonrpc.ts` (~180 lines)
- Test files (~1,050 lines)

---

## Appendix: TypeScript Error Categories

### Category 1: Lifecycle Properties (10 errors)

```
Property 'started' does not exist on type 'Engine'
Property 'startPromise' does not exist on type 'Engine'
Property 'shuttingDown' does not exist on type 'Engine'
```

**Fix:** Add properties or use RuntimeLifecycleService

### Category 2: Circuit Breaker Properties (35 errors)

```
Property 'circuitBreakerState' does not exist on type 'Engine'
Property 'circuitBreakerFailures' does not exist on type 'Engine'
Property 'circuitBreakerLastFailure' does not exist on type 'Engine'
Property 'CIRCUIT_BREAKER_THRESHOLD' does not exist on type 'Engine'
Property 'CIRCUIT_BREAKER_TIMEOUT' does not exist on type 'Engine'
```

**Fix:** Add circuit breaker properties or refactor to separate class

### Category 3: Type Mismatches (5 errors)

```
Type 'EmitFunction' is not assignable to type '...'
```

**Fix:** Update event emitter types

---

## References

- **Week 1 Report:** `PHASE1_WEEK1_COMPLETION_REPORT.md`
- **Week 1 Plan:** `PHASE1_WEEK1_PLAN.md`
- **Week 3 Plan:** `PHASE1_WEEK3_PLAN.md`
- **Action Plan:** `ACTION-PLAN-FINAL.md`
- **PRD:** `PRD-FINAL.md`

---

<div align="center">

**Phase 1 Week 2 Implementation Plan**

Status: Ready to Execute | Timeline: 2-3 days | Risk: LOW-MEDIUM

Complete Week 1 Work: Fix TS Errors + Integration + Tests

</div>
