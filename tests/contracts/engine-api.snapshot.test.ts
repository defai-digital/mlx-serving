import { describe, it, expect, expectTypeOf } from 'vitest';
import { Engine, createEngine } from '../../src/api/engine.js';
import {
  ENGINE_API_SNAPSHOT_VERSION,
  type EnginePublicAPI,
} from '../../src/api/contracts/engine-public-api.js';

describe('Engine API snapshot', () => {
  it('Engine class matches the public API snapshot', () => {
    expectTypeOf<InstanceType<typeof Engine>>().toMatchTypeOf<EnginePublicAPI>();

    type EngineKeys = keyof InstanceType<typeof Engine>;
    type SnapshotKeys = keyof EnginePublicAPI;

    // Detect accidental additions/removals in public surface
    expectTypeOf<Exclude<EngineKeys, SnapshotKeys>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<SnapshotKeys, EngineKeys>>().toEqualTypeOf<never>();
  });

  it('createEngine resolves to the snapshot type', () => {
    expectTypeOf<Awaited<ReturnType<typeof createEngine>>>().toMatchTypeOf<EnginePublicAPI>();
  });

  it('pins the snapshot version for release tracking', () => {
    expect(ENGINE_API_SNAPSHOT_VERSION).toBe('phase-0');
  });
});
