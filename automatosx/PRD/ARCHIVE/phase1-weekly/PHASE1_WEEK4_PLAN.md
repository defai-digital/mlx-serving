# Phase 1 Week 4: Telemetry & Event Schemas - Detailed Implementation Plan

**Date:** 2025-11-07
**Phase:** Phase 1 - Zod Integration (Week 4 of 18)
**Status:** READY TO START
**Timeline:** 4 days (20 hours total)
**Owner:** Bob (Backend Lead)
**Related:** ACTION-PLAN-FINAL.md, PRD-FINAL.md, PHASE1_WEEK3_PLAN.md

---

## Executive Summary

Week 4 focuses on creating Zod schemas for **telemetry configuration** and **event payloads**, completing the core validation infrastructure for mlx-serving. This work enables runtime validation of telemetry configs and all Engine event emissions.

### Scope

**Deliverables:**
1. **Telemetry Schemas** - Validate TelemetryConfig and KrServeMetrics
2. **Event Schemas** - Validate all 8 Engine event payloads
3. **Integration** - Add validation to telemetry/bridge.ts and api/events.ts
4. **Tests** - Comprehensive unit tests for schemas (~450 lines)

**Not in Scope:**
- Metrics collection logic (already implemented)
- Event emission logic (already implemented)
- OpenTelemetry infrastructure changes

---

## Context: What We're Building On

### Week 1-3 Accomplishments ✅

**Week 1:** Core API Schemas (80% complete)
- LoadModelOptions, GeneratorParams, TokenizeRequest schemas
- zodErrorToEngineError converter
- Blocked by pre-existing TS errors (to be fixed in Week 2)

**Week 2:** Complete Week 1 + Testing (Planned)
- Fix 50+ pre-existing TypeScript errors
- Integrate Zod validation into 4 Engine methods
- Write ~950 lines of schema tests

**Week 3:** Config & Bridge Schemas (Planned)
- RuntimeConfig schema (60+ properties)
- JSON-RPC validation (re-export existing schemas)
- Config loader integration

**Week 4 (This Plan):** Telemetry & Event Schemas
- TelemetryConfig validation
- 8 event payload schemas
- Validation integration

---

## Technical Analysis

### Telemetry Infrastructure

**Current Implementation:**

**File:** `src/telemetry/otel.ts` (344 lines)

**Interfaces to Validate:**

1. **TelemetryConfig** (19-40):
```typescript
export interface TelemetryConfig {
  enabled: boolean;
  serviceName?: string;          // default: 'kr-serve-mlx'
  prometheusPort?: number;        // default: 9464
  exportIntervalMs?: number;      // default: 60000
  logger?: Logger;                // pino logger (skip validation)
}
```

2. **KrServeMetrics** (57-82):
```typescript
export interface KrServeMetrics {
  // Model lifecycle (3 metrics)
  modelsLoaded: Counter;
  modelsUnloaded: Counter;
  modelLoadDuration: Histogram;

  // Token generation (3 metrics)
  tokensGenerated: Counter;
  generationDuration: Histogram;
  generationErrors: Counter;

  // IPC operations (3 metrics)
  ipcRequestsTotal: Counter;
  ipcRequestDuration: Histogram;
  ipcRequestsInFlight: Counter;

  // Batch operations (3 metrics)
  batchOperationsTotal: Counter;
  batchSizeHistogram: Histogram;
  batchEfficiency: Histogram;

  // Error tracking (3 metrics)
  errorsTotal: Counter;
  retryAttemptsTotal: Counter;
  circuitBreakerStateChanges: Counter;
}
```

**Note:** KrServeMetrics uses OpenTelemetry types (Counter, Histogram) which are NOT runtime-validatable. This interface is for type safety only, not runtime validation.

### Event Infrastructure

**Current Implementation:**

**File:** `src/api/events.ts` (109 lines)

**Interfaces to Validate:**

1. **ModelLoadedEvent** (13-19):
```typescript
export interface ModelLoadedEvent {
  model: string;
  modelPath: string;
  quantization?: string;
  parameters?: number;
  metadata?: Record<string, unknown>;
}
```

2. **ModelUnloadedEvent** (21-24):
```typescript
export interface ModelUnloadedEvent {
  model: string;
  reason?: string;
}
```

3. **ModelInvalidatedEvent** (26-29):
```typescript
export interface ModelInvalidatedEvent {
  model: string;
  reason: string;
}
```

4. **GenerationStartedEvent** (31-36):
```typescript
export interface GenerationStartedEvent {
  model: string;
  prompt: string | object;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}
```

5. **TokenGeneratedEvent** (38-43):
```typescript
export interface TokenGeneratedEvent {
  model: string;
  token: string;
  logprob?: number;
  metadata?: Record<string, unknown>;
}
```

6. **GenerationCompletedEvent** (45-52):
```typescript
export interface GenerationCompletedEvent {
  model: string;
  tokensGenerated: number;
  durationMs: number;
  throughput?: number;
  metadata?: Record<string, unknown>;
}
```

7. **ErrorEvent** (54-59):
```typescript
export interface ErrorEvent {
  error: string;
  code?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}
```

8. **RuntimeStatusEvent** (61-67):
```typescript
export interface RuntimeStatusEvent {
  status: 'ready' | 'busy' | 'error' | 'shutdown';
  modelsLoaded: number;
  activeTasks?: number;
  metadata?: Record<string, unknown>;
}
```

**EngineEvents Type Mapping** (69-78):
```typescript
export interface EngineEvents {
  modelLoaded: (event: ModelLoadedEvent) => void;
  modelUnloaded: (event: ModelUnloadedEvent) => void;
  modelInvalidated: (event: ModelInvalidatedEvent) => void;
  generationStarted: (event: GenerationStartedEvent) => void;
  tokenGenerated: (event: TokenGeneratedEvent) => void;
  generationCompleted: (event: GenerationCompletedEvent) => void;
  error: (event: ErrorEvent) => void;
  runtimeStatus: (event: RuntimeStatusEvent) => void;
}
```

---

## Week 4 Detailed Plan

### Day 1: Telemetry Schemas (5 hours)

#### Morning: Schema Design (2 hours)

**File:** `src/types/schemas/telemetry.ts` (~120 lines)

**Schemas to Create:**

1. **TelemetryConfigSchema**

```typescript
import { z } from 'zod';
import { PositiveInteger } from './common.js';

/**
 * Schema for OpenTelemetry telemetry configuration.
 *
 * Validates the TelemetryConfig interface from telemetry/otel.ts.
 * Ensures enabled is always set, and optional fields have valid defaults.
 *
 * @see {@link ../telemetry/otel.ts!TelemetryConfig}
 *
 * @example
 * ```typescript
 * const config = TelemetryConfigSchema.parse({
 *   enabled: true,
 *   serviceName: 'mlx-serving',
 *   prometheusPort: 9464,
 *   exportIntervalMs: 60000
 * });
 * ```
 */
export const TelemetryConfigSchema = z.object({
  /**
   * Enable metrics collection.
   */
  enabled: z.boolean(),

  /**
   * Service name for metrics (default: 'kr-serve-mlx').
   */
  serviceName: z
    .string()
    .min(1, 'Service name cannot be empty')
    .max(100, 'Service name cannot exceed 100 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Service name must be alphanumeric with hyphens/underscores')
    .optional(),

  /**
   * Prometheus exporter port (default: 9464).
   * Port must be in valid range 1024-65535 (non-privileged).
   */
  prometheusPort: PositiveInteger
    .min(1024, 'Port must be at least 1024 (non-privileged)')
    .max(65535, 'Port cannot exceed 65535')
    .optional(),

  /**
   * Metrics export interval in milliseconds (default: 60000).
   * Minimum 1 second, maximum 10 minutes.
   */
  exportIntervalMs: PositiveInteger
    .min(1000, 'Export interval must be at least 1 second')
    .max(600000, 'Export interval cannot exceed 10 minutes')
    .optional(),

  // Note: logger field is intentionally omitted from schema
  // Logger is a Pino instance and cannot be validated at runtime
}).strict(); // Use .strict() instead of .passthrough() - no extra fields allowed

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
```

**Design Rationale:**
- `.strict()` mode - Telemetry configs should not have extra fields (unlike API params)
- Port range 1024-65535 - Non-privileged ports only
- Service name regex - Prometheus metric naming conventions
- Export interval range - Prevent too frequent (performance) or too infrequent (stale metrics)
- Logger field omitted - Cannot validate Pino logger at runtime

2. **Metric Schemas** (Optional - For Documentation)

```typescript
/**
 * Schema for metric labels/attributes.
 *
 * Used to validate labels passed to metrics.add() and metrics.record().
 * All label values must be strings (OpenTelemetry requirement).
 *
 * @example
 * ```typescript
 * const labels = MetricLabelsSchema.parse({
 *   model: 'llama-3-8b',
 *   quantization: 'int4',
 *   operation: 'generate'
 * });
 * ```
 */
export const MetricLabelsSchema = z.record(
  z.string().min(1, 'Label key cannot be empty'),
  z.union([
    z.string(),
    z.number(),
    z.boolean()
  ]).transform(String) // OpenTelemetry requires string values
);

export type MetricLabels = z.infer<typeof MetricLabelsSchema>;
```

**Total:** ~120 lines

#### Afternoon: Telemetry Integration (3 hours)

**File:** `src/telemetry/bridge.ts` - Add validation (5 lines)

**Current Code** (bridge.ts:18-35):
```typescript
export class TelemetryBridge {
  private telemetry: TelemetryManager | null = null;
  private hooks: TelemetryHooks;
  private logger?: Logger;

  constructor(config: TelemetryConfig, hooks: TelemetryHooks = {}) {
    this.hooks = hooks;
    this.logger = config.logger;

    if (config.enabled) {
      this.telemetry = new TelemetryManager(config);
    }
  }
  // ...
}
```

**Add Zod Validation:**
```typescript
import { TelemetryConfigSchema, zodErrorToEngineError } from '../types/schemas/index.js';

export class TelemetryBridge {
  private telemetry: TelemetryManager | null = null;
  private hooks: TelemetryHooks;
  private logger?: Logger;

  constructor(config: TelemetryConfig, hooks: TelemetryHooks = {}) {
    // Validate config with Zod
    const parseResult = TelemetryConfigSchema.safeParse(config);
    if (!parseResult.success) {
      throw zodErrorToEngineError(parseResult.error);
    }

    this.hooks = hooks;
    this.logger = config.logger;

    if (config.enabled) {
      this.telemetry = new TelemetryManager(config);
    }
  }
  // ...
}
```

**Test Integration:**
```bash
npm run typecheck  # Verify no TS errors
npm run build      # Verify DTS generation
npm test           # Verify existing tests pass
```

---

### Day 2: Event Schemas (5 hours)

#### Morning: Event Schema Design (3 hours)

**File:** `src/types/schemas/events.ts` (~200 lines)

**Schemas to Create:**

1. **ModelLoadedEventSchema**

```typescript
import { z } from 'zod';
import { NonEmptyString, PositiveInteger } from './common.js';

/**
 * Schema for ModelLoadedEvent.
 *
 * Emitted when a model is successfully loaded into memory.
 *
 * @see {@link ../api/events.ts!ModelLoadedEvent}
 *
 * @example
 * ```typescript
 * const event = ModelLoadedEventSchema.parse({
 *   model: 'llama-3-8b',
 *   modelPath: '/models/llama-3-8b.safetensors',
 *   quantization: 'int4',
 *   parameters: 8000000000,
 *   metadata: { loadTime: 1234 }
 * });
 * ```
 */
export const ModelLoadedEventSchema = z.object({
  /**
   * Model identifier (e.g., 'llama-3-8b').
   */
  model: NonEmptyString,

  /**
   * Filesystem path or HuggingFace Hub identifier.
   */
  modelPath: NonEmptyString,

  /**
   * Quantization mode used ('none', 'int8', 'int4').
   */
  quantization: z.enum(['none', 'int8', 'int4']).optional(),

  /**
   * Total model parameters (for telemetry).
   */
  parameters: PositiveInteger.optional(),

  /**
   * Additional metadata (load time, memory usage, etc.).
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type ModelLoadedEvent = z.infer<typeof ModelLoadedEventSchema>;
```

2. **ModelUnloadedEventSchema**

```typescript
/**
 * Schema for ModelUnloadedEvent.
 *
 * Emitted when a model is unloaded from memory.
 *
 * @see {@link ../api/events.ts!ModelUnloadedEvent}
 */
export const ModelUnloadedEventSchema = z.object({
  /**
   * Model identifier.
   */
  model: NonEmptyString,

  /**
   * Reason for unloading (e.g., 'manual', 'cache-eviction', 'error').
   */
  reason: z.string().optional(),
}).strict();

export type ModelUnloadedEvent = z.infer<typeof ModelUnloadedEventSchema>;
```

3. **ModelInvalidatedEventSchema**

```typescript
/**
 * Schema for ModelInvalidatedEvent.
 *
 * Emitted when a model is invalidated (e.g., file changed on disk).
 *
 * @see {@link ../api/events.ts!ModelInvalidatedEvent}
 */
export const ModelInvalidatedEventSchema = z.object({
  /**
   * Model identifier.
   */
  model: NonEmptyString,

  /**
   * Reason for invalidation (required - e.g., 'file-changed', 'checksum-mismatch').
   */
  reason: NonEmptyString,
}).strict();

export type ModelInvalidatedEvent = z.infer<typeof ModelInvalidatedEventSchema>;
```

4. **GenerationStartedEventSchema**

```typescript
/**
 * Schema for GenerationStartedEvent.
 *
 * Emitted when text generation begins.
 *
 * @see {@link ../api/events.ts!GenerationStartedEvent}
 */
export const GenerationStartedEventSchema = z.object({
  /**
   * Model identifier.
   */
  model: NonEmptyString,

  /**
   * Prompt (string or object for templates/multimodal).
   */
  prompt: z.union([z.string(), z.record(z.unknown())]),

  /**
   * Maximum tokens to generate.
   */
  maxTokens: PositiveInteger.optional(),

  /**
   * Additional metadata (temperature, seed, etc.).
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type GenerationStartedEvent = z.infer<typeof GenerationStartedEventSchema>;
```

5. **TokenGeneratedEventSchema**

```typescript
/**
 * Schema for TokenGeneratedEvent.
 *
 * Emitted for each token generated during streaming.
 *
 * @see {@link ../api/events.ts!TokenGeneratedEvent}
 */
export const TokenGeneratedEventSchema = z.object({
  /**
   * Model identifier.
   */
  model: NonEmptyString,

  /**
   * Generated token (string).
   */
  token: z.string(), // Allow empty string (EOS token)

  /**
   * Log probability of this token (for sampling analysis).
   */
  logprob: z.number().optional(),

  /**
   * Additional metadata.
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type TokenGeneratedEvent = z.infer<typeof TokenGeneratedEventSchema>;
```

6. **GenerationCompletedEventSchema**

```typescript
/**
 * Schema for GenerationCompletedEvent.
 *
 * Emitted when text generation finishes.
 *
 * @see {@link ../api/events.ts!GenerationCompletedEvent}
 */
export const GenerationCompletedEventSchema = z.object({
  /**
   * Model identifier.
   */
  model: NonEmptyString,

  /**
   * Total tokens generated.
   */
  tokensGenerated: z.number().int('Must be an integer').nonnegative('Cannot be negative'),

  /**
   * Total generation time in milliseconds.
   */
  durationMs: z.number().nonnegative('Duration cannot be negative'),

  /**
   * Tokens per second (throughput).
   */
  throughput: z.number().nonnegative('Throughput cannot be negative').optional(),

  /**
   * Additional metadata.
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type GenerationCompletedEvent = z.infer<typeof GenerationCompletedEventSchema>;
```

7. **ErrorEventSchema**

```typescript
/**
 * Schema for ErrorEvent.
 *
 * Emitted when an error occurs in the Engine.
 *
 * @see {@link ../api/events.ts!ErrorEvent}
 */
export const ErrorEventSchema = z.object({
  /**
   * Error message.
   */
  error: NonEmptyString,

  /**
   * Error code (e.g., 'ModelNotFound', 'GenerationFailed').
   */
  code: z.string().optional(),

  /**
   * Model identifier (if error is model-specific).
   */
  model: z.string().optional(),

  /**
   * Additional metadata.
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
```

8. **RuntimeStatusEventSchema**

```typescript
/**
 * Schema for RuntimeStatusEvent.
 *
 * Emitted periodically to report runtime status.
 *
 * @see {@link ../api/events.ts!RuntimeStatusEvent}
 */
export const RuntimeStatusEventSchema = z.object({
  /**
   * Runtime status.
   */
  status: z.enum(['ready', 'busy', 'error', 'shutdown'], {
    errorMap: () => ({ message: 'Status must be one of: ready, busy, error, shutdown' }),
  }),

  /**
   * Number of models currently loaded.
   */
  modelsLoaded: z.number().int('Must be an integer').nonnegative('Cannot be negative'),

  /**
   * Number of active generation tasks.
   */
  activeTasks: z.number().int('Must be an integer').nonnegative('Cannot be negative').optional(),

  /**
   * Additional metadata.
   */
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type RuntimeStatusEvent = z.infer<typeof RuntimeStatusEventSchema>;
```

**Total:** ~200 lines

#### Afternoon: Event Integration (2 hours)

**File:** `src/api/events.ts` - Add validation helper

**Current Code** (events.ts:80-109):
```typescript
export class EngineEventEmitter extends EventEmitter<EngineEvents> {
  constructor(private logger?: Logger) {
    super();
  }

  public emitModelLoaded(event: ModelLoadedEvent): void {
    this.logger?.debug({ event }, 'Model loaded');
    this.emit('modelLoaded', event);
  }

  public emitModelUnloaded(event: ModelUnloadedEvent): void {
    this.logger?.debug({ event }, 'Model unloaded');
    this.emit('modelUnloaded', event);
  }

  // ... 6 more emit methods
}
```

**Add Validation:**

```typescript
import {
  ModelLoadedEventSchema,
  ModelUnloadedEventSchema,
  ModelInvalidatedEventSchema,
  GenerationStartedEventSchema,
  TokenGeneratedEventSchema,
  GenerationCompletedEventSchema,
  ErrorEventSchema,
  RuntimeStatusEventSchema,
} from '../types/schemas/index.js';
import { zodErrorToEngineError } from './errors.js';

export class EngineEventEmitter extends EventEmitter<EngineEvents> {
  constructor(private logger?: Logger) {
    super();
  }

  public emitModelLoaded(event: ModelLoadedEvent): void {
    const parseResult = ModelLoadedEventSchema.safeParse(event);
    if (!parseResult.success) {
      this.logger?.error({ error: parseResult.error }, 'Invalid ModelLoadedEvent payload');
      throw zodErrorToEngineError(parseResult.error);
    }
    this.logger?.debug({ event }, 'Model loaded');
    this.emit('modelLoaded', event);
  }

  public emitModelUnloaded(event: ModelUnloadedEvent): void {
    const parseResult = ModelUnloadedEventSchema.safeParse(event);
    if (!parseResult.success) {
      this.logger?.error({ error: parseResult.error }, 'Invalid ModelUnloadedEvent payload');
      throw zodErrorToEngineError(parseResult.error);
    }
    this.logger?.debug({ event }, 'Model unloaded');
    this.emit('modelUnloaded', event);
  }

  // ... repeat for all 8 emit methods
}
```

**Alternative: Validation Helper Function**

To avoid duplication, create a helper:

```typescript
/**
 * Validate an event payload with a Zod schema.
 * Throws EngineClientError if validation fails.
 */
private validateEvent<T>(
  schema: z.ZodSchema<T>,
  event: unknown,
  eventName: string
): T {
  const parseResult = schema.safeParse(event);
  if (!parseResult.success) {
    this.logger?.error({ error: parseResult.error, eventName }, 'Invalid event payload');
    throw zodErrorToEngineError(parseResult.error);
  }
  return parseResult.data;
}

public emitModelLoaded(event: ModelLoadedEvent): void {
  const validated = this.validateEvent(ModelLoadedEventSchema, event, 'modelLoaded');
  this.logger?.debug({ event: validated }, 'Model loaded');
  this.emit('modelLoaded', validated);
}

public emitModelUnloaded(event: ModelUnloadedEvent): void {
  const validated = this.validateEvent(ModelUnloadedEventSchema, event, 'modelUnloaded');
  this.logger?.debug({ event: validated }, 'Model unloaded');
  this.emit('modelUnloaded', validated);
}

// ... repeat for all 8 emit methods
```

**Total Changes:** ~60 lines added to events.ts

---

### Day 3: Testing (8 hours)

#### Morning: Telemetry Schema Tests (4 hours)

**File:** `tests/unit/schemas/telemetry.test.ts` (~200 lines)

```typescript
import { describe, it, expect } from 'vitest';
import { TelemetryConfigSchema, MetricLabelsSchema } from '@/types/schemas/telemetry.js';

describe('TelemetryConfigSchema', () => {
  describe('Valid configurations', () => {
    it('should accept minimal config (enabled only)', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
      });
      expect(config.enabled).toBe(true);
    });

    it('should accept full config with all fields', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        serviceName: 'mlx-serving',
        prometheusPort: 9464,
        exportIntervalMs: 60000,
      });
      expect(config).toEqual({
        enabled: true,
        serviceName: 'mlx-serving',
        prometheusPort: 9464,
        exportIntervalMs: 60000,
      });
    });

    it('should accept disabled config', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: false,
      });
      expect(config.enabled).toBe(false);
    });

    it('should accept service name with hyphens and underscores', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        serviceName: 'mlx-serving_v2',
      });
      expect(config.serviceName).toBe('mlx-serving_v2');
    });

    it('should accept minimum port (1024)', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        prometheusPort: 1024,
      });
      expect(config.prometheusPort).toBe(1024);
    });

    it('should accept maximum port (65535)', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        prometheusPort: 65535,
      });
      expect(config.prometheusPort).toBe(65535);
    });

    it('should accept minimum export interval (1000ms)', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        exportIntervalMs: 1000,
      });
      expect(config.exportIntervalMs).toBe(1000);
    });

    it('should accept maximum export interval (600000ms)', () => {
      const config = TelemetryConfigSchema.parse({
        enabled: true,
        exportIntervalMs: 600000,
      });
      expect(config.exportIntervalMs).toBe(600000);
    });
  });

  describe('Invalid configurations', () => {
    it('should reject missing enabled field', () => {
      expect(() => TelemetryConfigSchema.parse({})).toThrow();
    });

    it('should reject non-boolean enabled', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: 'true', // string instead of boolean
        })
      ).toThrow();
    });

    it('should reject empty service name', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          serviceName: '',
        })
      ).toThrow('Service name cannot be empty');
    });

    it('should reject service name > 100 characters', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          serviceName: 'a'.repeat(101),
        })
      ).toThrow('Service name cannot exceed 100 characters');
    });

    it('should reject service name with invalid characters', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          serviceName: 'mlx-serving@v2', // @ not allowed
        })
      ).toThrow('Service name must be alphanumeric');
    });

    it('should reject port below 1024', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          prometheusPort: 80, // privileged port
        })
      ).toThrow('Port must be at least 1024');
    });

    it('should reject port above 65535', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          prometheusPort: 70000,
        })
      ).toThrow('Port cannot exceed 65535');
    });

    it('should reject non-integer port', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          prometheusPort: 9464.5,
        })
      ).toThrow();
    });

    it('should reject export interval < 1 second', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          exportIntervalMs: 500,
        })
      ).toThrow('Export interval must be at least 1 second');
    });

    it('should reject export interval > 10 minutes', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          exportIntervalMs: 700000,
        })
      ).toThrow('Export interval cannot exceed 10 minutes');
    });

    it('should reject extra fields (strict mode)', () => {
      expect(() =>
        TelemetryConfigSchema.parse({
          enabled: true,
          extraField: 'not allowed',
        })
      ).toThrow();
    });
  });

  describe('Error messages', () => {
    it('should provide clear error for invalid service name', () => {
      const result = TelemetryConfigSchema.safeParse({
        enabled: true,
        serviceName: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['serviceName']);
        expect(result.error.issues[0].message).toContain('cannot be empty');
      }
    });

    it('should provide clear error for invalid port', () => {
      const result = TelemetryConfigSchema.safeParse({
        enabled: true,
        prometheusPort: 80,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['prometheusPort']);
        expect(result.error.issues[0].message).toContain('at least 1024');
      }
    });
  });
});

describe('MetricLabelsSchema', () => {
  it('should accept string labels', () => {
    const labels = MetricLabelsSchema.parse({
      model: 'llama-3-8b',
      operation: 'generate',
    });
    expect(labels.model).toBe('llama-3-8b');
  });

  it('should accept number labels and convert to string', () => {
    const labels = MetricLabelsSchema.parse({
      port: 9464,
    });
    expect(labels.port).toBe('9464');
  });

  it('should accept boolean labels and convert to string', () => {
    const labels = MetricLabelsSchema.parse({
      enabled: true,
    });
    expect(labels.enabled).toBe('true');
  });

  it('should reject empty label keys', () => {
    expect(() =>
      MetricLabelsSchema.parse({
        '': 'value',
      })
    ).toThrow('Label key cannot be empty');
  });
});
```

**Total:** ~200 lines

#### Afternoon: Event Schema Tests (4 hours)

**File:** `tests/unit/schemas/events.test.ts` (~250 lines)

```typescript
import { describe, it, expect } from 'vitest';
import {
  ModelLoadedEventSchema,
  ModelUnloadedEventSchema,
  ModelInvalidatedEventSchema,
  GenerationStartedEventSchema,
  TokenGeneratedEventSchema,
  GenerationCompletedEventSchema,
  ErrorEventSchema,
  RuntimeStatusEventSchema,
} from '@/types/schemas/events.js';

describe('ModelLoadedEventSchema', () => {
  it('should accept minimal event', () => {
    const event = ModelLoadedEventSchema.parse({
      model: 'llama-3-8b',
      modelPath: '/models/llama-3-8b',
    });
    expect(event.model).toBe('llama-3-8b');
  });

  it('should accept full event with metadata', () => {
    const event = ModelLoadedEventSchema.parse({
      model: 'llama-3-8b',
      modelPath: '/models/llama-3-8b',
      quantization: 'int4',
      parameters: 8000000000,
      metadata: { loadTime: 1234 },
    });
    expect(event.quantization).toBe('int4');
    expect(event.parameters).toBe(8000000000);
  });

  it('should reject empty model', () => {
    expect(() =>
      ModelLoadedEventSchema.parse({
        model: '',
        modelPath: '/models/llama-3-8b',
      })
    ).toThrow();
  });

  it('should reject invalid quantization', () => {
    expect(() =>
      ModelLoadedEventSchema.parse({
        model: 'llama-3-8b',
        modelPath: '/models/llama-3-8b',
        quantization: 'int16', // not valid
      })
    ).toThrow();
  });

  it('should reject negative parameters', () => {
    expect(() =>
      ModelLoadedEventSchema.parse({
        model: 'llama-3-8b',
        modelPath: '/models/llama-3-8b',
        parameters: -100,
      })
    ).toThrow();
  });
});

describe('ModelUnloadedEventSchema', () => {
  it('should accept minimal event', () => {
    const event = ModelUnloadedEventSchema.parse({
      model: 'llama-3-8b',
    });
    expect(event.model).toBe('llama-3-8b');
  });

  it('should accept event with reason', () => {
    const event = ModelUnloadedEventSchema.parse({
      model: 'llama-3-8b',
      reason: 'manual',
    });
    expect(event.reason).toBe('manual');
  });
});

describe('ModelInvalidatedEventSchema', () => {
  it('should accept valid event', () => {
    const event = ModelInvalidatedEventSchema.parse({
      model: 'llama-3-8b',
      reason: 'file-changed',
    });
    expect(event.reason).toBe('file-changed');
  });

  it('should reject missing reason', () => {
    expect(() =>
      ModelInvalidatedEventSchema.parse({
        model: 'llama-3-8b',
      })
    ).toThrow();
  });

  it('should reject empty reason', () => {
    expect(() =>
      ModelInvalidatedEventSchema.parse({
        model: 'llama-3-8b',
        reason: '',
      })
    ).toThrow();
  });
});

describe('GenerationStartedEventSchema', () => {
  it('should accept string prompt', () => {
    const event = GenerationStartedEventSchema.parse({
      model: 'llama-3-8b',
      prompt: 'Tell me a story',
    });
    expect(event.prompt).toBe('Tell me a story');
  });

  it('should accept object prompt (template)', () => {
    const event = GenerationStartedEventSchema.parse({
      model: 'llama-3-8b',
      prompt: { template: 'Hello {{name}}', name: 'Alice' },
    });
    expect(typeof event.prompt).toBe('object');
  });

  it('should accept maxTokens', () => {
    const event = GenerationStartedEventSchema.parse({
      model: 'llama-3-8b',
      prompt: 'Test',
      maxTokens: 100,
    });
    expect(event.maxTokens).toBe(100);
  });

  it('should reject negative maxTokens', () => {
    expect(() =>
      GenerationStartedEventSchema.parse({
        model: 'llama-3-8b',
        prompt: 'Test',
        maxTokens: -10,
      })
    ).toThrow();
  });
});

describe('TokenGeneratedEventSchema', () => {
  it('should accept valid token', () => {
    const event = TokenGeneratedEventSchema.parse({
      model: 'llama-3-8b',
      token: 'Hello',
    });
    expect(event.token).toBe('Hello');
  });

  it('should accept empty token (EOS)', () => {
    const event = TokenGeneratedEventSchema.parse({
      model: 'llama-3-8b',
      token: '',
    });
    expect(event.token).toBe('');
  });

  it('should accept logprob', () => {
    const event = TokenGeneratedEventSchema.parse({
      model: 'llama-3-8b',
      token: 'Hello',
      logprob: -0.5,
    });
    expect(event.logprob).toBe(-0.5);
  });
});

describe('GenerationCompletedEventSchema', () => {
  it('should accept valid completion', () => {
    const event = GenerationCompletedEventSchema.parse({
      model: 'llama-3-8b',
      tokensGenerated: 100,
      durationMs: 1234,
    });
    expect(event.tokensGenerated).toBe(100);
  });

  it('should accept zero tokens', () => {
    const event = GenerationCompletedEventSchema.parse({
      model: 'llama-3-8b',
      tokensGenerated: 0,
      durationMs: 100,
    });
    expect(event.tokensGenerated).toBe(0);
  });

  it('should reject negative tokens', () => {
    expect(() =>
      GenerationCompletedEventSchema.parse({
        model: 'llama-3-8b',
        tokensGenerated: -10,
        durationMs: 1234,
      })
    ).toThrow();
  });

  it('should reject negative duration', () => {
    expect(() =>
      GenerationCompletedEventSchema.parse({
        model: 'llama-3-8b',
        tokensGenerated: 100,
        durationMs: -100,
      })
    ).toThrow();
  });

  it('should accept throughput', () => {
    const event = GenerationCompletedEventSchema.parse({
      model: 'llama-3-8b',
      tokensGenerated: 100,
      durationMs: 1000,
      throughput: 100,
    });
    expect(event.throughput).toBe(100);
  });
});

describe('ErrorEventSchema', () => {
  it('should accept minimal error', () => {
    const event = ErrorEventSchema.parse({
      error: 'Model not found',
    });
    expect(event.error).toBe('Model not found');
  });

  it('should accept full error with code and model', () => {
    const event = ErrorEventSchema.parse({
      error: 'Model not found',
      code: 'ModelNotFound',
      model: 'llama-3-8b',
    });
    expect(event.code).toBe('ModelNotFound');
  });

  it('should reject empty error message', () => {
    expect(() =>
      ErrorEventSchema.parse({
        error: '',
      })
    ).toThrow();
  });
});

describe('RuntimeStatusEventSchema', () => {
  it('should accept valid status', () => {
    const event = RuntimeStatusEventSchema.parse({
      status: 'ready',
      modelsLoaded: 2,
    });
    expect(event.status).toBe('ready');
  });

  it('should accept all status values', () => {
    const statuses = ['ready', 'busy', 'error', 'shutdown'] as const;
    for (const status of statuses) {
      const event = RuntimeStatusEventSchema.parse({
        status,
        modelsLoaded: 0,
      });
      expect(event.status).toBe(status);
    }
  });

  it('should reject invalid status', () => {
    expect(() =>
      RuntimeStatusEventSchema.parse({
        status: 'starting', // not valid
        modelsLoaded: 0,
      })
    ).toThrow('Status must be one of');
  });

  it('should accept activeTasks', () => {
    const event = RuntimeStatusEventSchema.parse({
      status: 'busy',
      modelsLoaded: 2,
      activeTasks: 3,
    });
    expect(event.activeTasks).toBe(3);
  });

  it('should reject negative modelsLoaded', () => {
    expect(() =>
      RuntimeStatusEventSchema.parse({
        status: 'ready',
        modelsLoaded: -1,
      })
    ).toThrow();
  });

  it('should reject negative activeTasks', () => {
    expect(() =>
      RuntimeStatusEventSchema.parse({
        status: 'busy',
        modelsLoaded: 2,
        activeTasks: -1,
      })
    ).toThrow();
  });
});
```

**Total:** ~250 lines

---

### Day 4: Validation & Documentation (2 hours)

#### Full Test Suite (30 min)

```bash
npm test
# Expected: 373+ tests passing (baseline) + ~50 new tests = 423+ tests
```

#### Build Validation (30 min)

```bash
npm run clean
npm run build
npm run typecheck
npm run lint
# All should pass
```

#### Coverage Analysis (30 min)

```bash
npm run test:coverage
# Expected: ≥90% for telemetry.ts and events.ts schema files
```

#### Completion Report (30 min)

**File:** `automatosx/PRD/PHASE1_WEEK4_COMPLETION_REPORT.md`

**Sections:**
- Executive summary
- Deliverables completed
- Test results
- Code statistics
- Next steps (Week 5)

---

## Code Statistics

### New Files Created (470 lines)

| File | Lines | Description |
|------|-------|-------------|
| `src/types/schemas/telemetry.ts` | 120 | TelemetryConfig + MetricLabels schemas |
| `src/types/schemas/events.ts` | 200 | 8 event payload schemas |
| `tests/unit/schemas/telemetry.test.ts` | 200 | Telemetry schema tests |
| `tests/unit/schemas/events.test.ts` | 250 | Event schema tests |

### Modified Files (70 lines)

| File | Change | Description |
|------|--------|-------------|
| `src/telemetry/bridge.ts` | +5 lines | Add TelemetryConfig validation |
| `src/api/events.ts` | +60 lines | Add event validation to 8 emit methods |
| `src/types/schemas/index.ts` | +5 lines | Export telemetry and event schemas |

### Documentation (40 pages)

| File | Pages | Description |
|------|-------|-------------|
| `PHASE1_WEEK4_PLAN.md` | 25 | This document |
| `PHASE1_WEEK4_SUMMARY.md` | 10 | Executive summary |
| `PHASE1_WEEK4_COMPLETION_REPORT.md` | 15 | Completion report (created Day 4) |

**Total:** 540 lines of code, 40 pages of documentation

---

## Success Criteria

### Must Have ✅

- [ ] TelemetryConfigSchema validates all config properties
- [ ] 8 event payload schemas created
- [ ] Validation integrated into TelemetryBridge constructor
- [ ] Validation integrated into EngineEventEmitter.emit*() methods
- [ ] ≥90% test coverage for telemetry.ts and events.ts
- [ ] 423+ tests passing (373 baseline + 50 new)
- [ ] npm run build succeeds (ESM + CJS + DTS)
- [ ] npm run typecheck passes
- [ ] Completion report created

### Nice to Have

- [ ] MetricLabelsSchema for validating metric attributes
- [ ] Performance benchmarks (±5% baseline)
- [ ] Manual validation with real Python runtime

---

## Timeline

| Day | Focus | Hours | Status |
|-----|-------|-------|--------|
| **Day 1 AM** | Telemetry schema design | 2 | 📋 Planned |
| **Day 1 PM** | Telemetry integration | 3 | 📋 Planned |
| **Day 2 AM** | Event schema design | 3 | 📋 Planned |
| **Day 2 PM** | Event integration | 2 | 📋 Planned |
| **Day 3 AM** | Telemetry schema tests | 4 | 📋 Planned |
| **Day 3 PM** | Event schema tests | 4 | 📋 Planned |
| **Day 4** | Validation + docs | 2 | 📋 Planned |

**Total:** 20 hours over 4 days

---

## Risk Assessment

### LOW Risk ✅

1. **Schema Patterns Established**
   - Week 1-3 established clear schema patterns
   - Similar complexity to previous weeks
   - Event interfaces already well-defined

2. **Simple Integration**
   - TelemetryBridge: 1 validation call in constructor
   - EngineEventEmitter: 8 validation calls in emit methods
   - No complex logic changes

3. **Clear Test Strategy**
   - Test patterns from Weeks 1-2
   - Event payloads straightforward to test
   - High coverage achievable

### MEDIUM Risk ⚠️

1. **Event Validation Performance**
   - Concern: Validating every event (especially TokenGeneratedEvent) could add overhead
   - Mitigation: Use .safeParse() to avoid exceptions, measure performance
   - Fallback: Make event validation optional via config flag

2. **Logger Field Handling**
   - Concern: TelemetryConfig.logger is a Pino instance (not validatable)
   - Mitigation: Omit from schema, document in JSDoc
   - Impact: Minimal - logger is optional

---

## Dependencies

### Completed ✅

- Zod v3.22.4 installed (Week 1)
- zodErrorToEngineError converter (Week 1)
- Schema patterns established (Weeks 1-3)

### Required

- Week 2 completion (fix TS errors, integrate Zod validation)
- Test infrastructure working
- DTS build pipeline working

### No New Dependencies

All packages already installed.

---

## What Comes After Week 4

### Week 5: Integration & Error Handling

**Deliverables:**
- Integrate all Zod schemas into Engine methods
- Comprehensive error handling tests
- Performance validation (no regression)
- Contract tests vs kr-serve-mlx

**Timeline:** 5 days (26 hours)

### Week 6: Documentation & Testing

**Deliverables:**
- API documentation (schemas, validation)
- Migration guide (manual validators → Zod)
- Performance benchmarks
- Final validation

**Timeline:** 3 days (15 hours)

---

## Bottom Line

Phase 1 Week 4 completes the **telemetry and event validation infrastructure**:

- ✅ Straightforward schema design (8 events + 1 config)
- ✅ Simple integration (TelemetryBridge + EngineEventEmitter)
- ✅ Clear test strategy (~450 lines)
- ✅ Timeline: 4 days (20 hours)
- ✅ Risk: LOW (established patterns)

**After Week 4:** All core validation schemas complete. Week 5 focuses on integration, error handling, and performance validation.

---

<div align="center">

**Phase 1 Week 4 Status: READY TO START**

Telemetry & Event Schemas | 4 Days | 20 Hours | LOW Risk

Complete validation for all telemetry configs and Engine events.

</div>
