/**
 * Model Lifecycle Manager
 *
 * Phase 3.3 component responsible for keeping GPU memory usage stable by
 * unloading idle models, warming frequently accessed models, and proactively
 * prefetching likely-next models. Mirrors the architecture described in
 * PHASE3-IMPLEMENTATION-GUIDE.md (Section 2.3).
 *
 * Responsibilities:
 * - Track per-model usage (access timestamps, in-flight requests, pin status)
 * - Enforce LRU policy capped by maxLoadedModels
 * - Gracefully drain and unload idle models after idleTimeoutMs
 * - Predictive prefetch using transition frequency heuristics
 * - Warmup configured models on startup
 * - Emit lifecycle events for observability and tests
 */

import { EventEmitter } from 'eventemitter3';
import type { Logger } from 'pino';
import type { ModelHandle } from '../types/models.js';
import type { ModelIdentifier } from '../types/engine.js';

/**
 * Configuration for ModelLifecycleManager (Phase 3.3 spec)
 */
export interface ModelLifecycleManagerConfig {
  enabled: boolean;
  idleTimeoutMs: number;
  maxLoadedModels: number;
  prefetchEnabled: boolean;
  prefetchMinConfidence: number;
  warmupsOnStartup: string[];
  pinnedModels: string[];
  drainTimeoutMs: number;
  logger?: Logger;
}

/**
 * Lifecycle status for a model (diagnostics API)
 */
export interface ModelStatus {
  modelId: string;
  loaded: boolean;
  lastAccessedMs: number;
  lastLoadedMs?: number;
  lastUnloadedMs?: number;
  inFlightRequests: number;
  isPinned: boolean;
  isPrefetching: boolean;
  memoryUsageBytes?: number;
}

/**
 * Lifecycle metrics exposed for monitoring
 */
export interface LifecycleMetrics {
  avgColdLoadMs: number;
  avgWarmLoadMs: number;
  unloadCount: number;
  prefetchHitRate: number;
  prefetchRequests?: number;
  prefetchHits?: number;
  idleUnloadCount?: number;
  manualUnloadCount?: number;
  loadedModels?: number;
  pinnedModels?: number;
  estimatedMemoryBytes?: number;
}

/**
 * Prefetch prediction output
 */
export interface Prediction {
  modelId: string;
  confidence: number;
  source: 'transition' | 'recency';
  lastSeenMs: number;
}

export type LoadOrigin = 'manual' | 'prefetch' | 'warmup';
export type UnloadReason = 'manual' | 'idle' | 'capacity' | 'shutdown';

/**
 * Load time sample for cold/warm load latency tracking
 */
export interface LoadTimeSample {
  modelId: string;
  durationMs: number;
  timestamp: number;
  type: 'cold' | 'warm';
  origin: LoadOrigin;
}

/**
 * Warmup summary emitted after startup warmup finishes
 */
export interface WarmupResult {
  completed: string[];
  failed: Array<{ modelId: string; error: Error }>; // Provide context for logs/tests
  durationMs: number;
}

/**
 * Lifecycle events emitted by the manager
 */
export interface ModelLifecycleEvents {
  modelLoaded: (modelId: string, status: ModelStatus, origin: LoadOrigin) => void;
  modelUnloaded: (modelId: string, reason: UnloadReason) => void;
  modelAccessed: (modelId: string, status: ModelStatus) => void;
  prefetchStarted: (prediction: Prediction) => void;
  prefetchCompleted: (modelId: string, success: boolean) => void;
  warmupCompleted: (result: WarmupResult) => void;
}

/**
 * Runtime adapter required from ModelManager (or equivalent)
 */
export interface ModelRuntimeController {
  loadModel(options: { model: string } | string): Promise<ModelHandle>;
  unloadModel(modelId: ModelIdentifier): Promise<void>;
  isLoaded?(modelId: ModelIdentifier): boolean;
  getHandle?(modelId: ModelIdentifier): ModelHandle | undefined;
}

/** Internal per-model tracking structure */
interface ModelInfo {
  id: string;
  loaded: boolean;
  lastAccessedMs: number;
  lastLoadedMs?: number;
  lastUnloadedMs?: number;
  loadCount: number;
  inFlightRequests: number;
  isPinned: boolean;
  isPrefetching: boolean;
  pendingUnload?: UnloadReason;
  memoryUsageBytes?: number;
}

interface TransitionCounter {
  count: number;
  lastAccessedMs: number;
}

interface PrefetchRecord {
  modelId: string;
  prediction: Prediction;
  requestedAt: number;
  completedAt?: number;
  status: 'pending' | 'loaded' | 'failed';
}

type PrefetchTrigger = 'access' | 'idle' | 'warmup' | 'manual' | 'drain';

type DrainResolution = (drained: boolean) => void;

/** Default configuration values */
const DEFAULT_CONFIG: ModelLifecycleManagerConfig = {
  enabled: true,
  idleTimeoutMs: 300000,
  maxLoadedModels: 5,
  prefetchEnabled: true,
  prefetchMinConfidence: 0.7,
  warmupsOnStartup: [],
  pinnedModels: [],
  drainTimeoutMs: 30000,
};

const IDLE_SWEEP_INTERVAL_MS = 60000;
const PREFETCH_PREDICTION_LIMIT = 5;
const PREFETCH_MAX_CONCURRENCY = 2;
const PREFETCH_HIT_WINDOW_MS = 5 * 60 * 1000;
const LOAD_SAMPLE_HISTORY_SIZE = 50;
const ACCESS_HISTORY_SIZE = 64;

/** Utilities */
import { safeAverage } from '@/utils/math-helpers.js';

const average = (samples: LoadTimeSample[], type: 'cold' | 'warm'): number => {
  const filtered = samples.filter((sample) => sample.type === type);
  const durations = filtered.map(sample => sample.durationMs);
  return safeAverage(durations);
};

/**
 * ModelLifecycleManager implementation
 */
export class ModelLifecycleManager extends EventEmitter<ModelLifecycleEvents> {
  private readonly config: ModelLifecycleManagerConfig;
  private readonly controller: ModelRuntimeController;
  private readonly logger?: Logger;
  private readonly modelState = new Map<string, ModelInfo>();
  private readonly transitionGraph = new Map<string, Map<string, TransitionCounter>>();
  private readonly transitionTotals = new Map<string, number>();
  private readonly loadSamples: LoadTimeSample[] = [];
  private readonly pendingLoads = new Map<string, Promise<void>>();
  private readonly pendingUnloads = new Map<string, Promise<void>>();
  private readonly drainWaiters = new Map<string, Set<DrainResolution>>();
  private readonly prefetchRecords = new Map<string, PrefetchRecord>();
  private readonly recentAccesses: string[] = [];
  private readonly pinned = new Set<string>();

  private idleSweepTimer: NodeJS.Timeout | null = null;
  private prefetchCycleScheduled = false;
  private prefetchConcurrency = 0;
  private lastAccessedModel: string | null = null;
  private globalInFlightRequests = 0;
  private disposed = false;
  private loggedPinnedOverflow = false;

  private metrics = {
    unloadCount: 0,
    idleUnloadCount: 0,
    manualUnloadCount: 0,
    prefetchRequests: 0,
    prefetchHits: 0,
  };

  constructor(
    controller: ModelRuntimeController,
    config: Partial<ModelLifecycleManagerConfig> = {}
  ) {
    super();
    this.controller = controller;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      warmupsOnStartup: config.warmupsOnStartup ?? DEFAULT_CONFIG.warmupsOnStartup,
      pinnedModels: config.pinnedModels ?? DEFAULT_CONFIG.pinnedModels,
    };
    this.logger = this.config.logger;
    this.config.prefetchMinConfidence = Math.min(
      1,
      Math.max(0, this.config.prefetchMinConfidence)
    );
    this.config.maxLoadedModels = Math.max(1, this.config.maxLoadedModels);
    this.pinned = new Set(this.config.pinnedModels);
    this.initializePinnedState();
    this.startIdleSweep();
  }

  /** Clean up timers and pending listeners */
  public dispose(): void {
    this.disposed = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    this.drainWaiters.clear();
    this.pendingLoads.clear();
    this.pendingUnloads.clear();
  }

  /** Warm up configured models on engine startup */
  public async startWarmupCycle(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const { warmupsOnStartup } = this.config;
    if (!warmupsOnStartup || warmupsOnStartup.length === 0) {
      return;
    }

    const start = Date.now();
    const completed: string[] = [];
    const failed: Array<{ modelId: string; error: Error }> = [];

    for (const modelId of warmupsOnStartup) {
      try {
        await this.preloadModel(modelId, 'warmup');
        completed.push(modelId);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        failed.push({ modelId, error: err });
        this.logger?.warn({ modelId, error: err }, 'Warmup preload failed');
      }
    }

    const result: WarmupResult = {
      completed,
      failed,
      durationMs: Date.now() - start,
    };
    this.emit('warmupCompleted', result);
    if (failed.length === 0) {
      this.logger?.info({ completed }, 'Warmup cycle completed');
    }
    this.schedulePrefetchCycle('warmup');
  }

  /** Mark that a model has just been accessed */
  public markModelAccessed(modelId: string): void {
    if (this.disposed) {
      return;
    }
    const info = this.ensureModelInfo(modelId);
    const now = Date.now();
    info.lastAccessedMs = now;
    info.loaded = true;
    info.inFlightRequests += 1;
    this.globalInFlightRequests += 1;
    this.recordAccessHistory(modelId);
    this.recordTransition(modelId);
    this.registerPrefetchHit(modelId);
    const status = this.toModelStatus(info);
    this.emit('modelAccessed', status.modelId, status);
    this.schedulePrefetchCycle('access');
  }

  /** Mark that a request tied to a model has completed (StreamRegistry hook) */
  public markModelReleased(modelId: string): void {
    const info = this.modelState.get(modelId);
    if (!info) {
      return;
    }
    if (info.inFlightRequests > 0) {
      info.inFlightRequests -= 1;
    }
    if (this.globalInFlightRequests > 0) {
      this.globalInFlightRequests -= 1;
    }
    if (info.inFlightRequests === 0) {
      this.notifyDrainWaiters(modelId);
    }
    if (this.globalInFlightRequests === 0) {
      this.schedulePrefetchCycle('drain');
    }
  }

  /** Preload (or keep warm) a model */
  public async preloadModel(modelId: string, origin: LoadOrigin = 'manual'): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.pinned.has(modelId)) {
      const info = this.ensureModelInfo(modelId);
      info.isPinned = true;
    }
    await this.performLoad(modelId, origin);
    await this.enforceCapacity(modelId);
  }

  /** Force unload of a model, draining in-flight requests first */
  public async unloadModel(modelId: string, reason: UnloadReason = 'manual'): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.pinned.has(modelId)) {
      this.logger?.debug({ modelId }, 'Skipping unload for pinned model');
      return;
    }
    await this.executeUnload(modelId, reason);
  }

  /** Retrieve per-model status snapshot */
  public getModelStatus(modelId: string): ModelStatus {
    const info = this.modelState.get(modelId) ?? this.ensureModelInfo(modelId);
    return this.toModelStatus(info);
  }

  /** Retrieve lifecycle-level metrics */
  public getLifecycleMetrics(): LifecycleMetrics {
    const avgColdLoadMs = average(this.loadSamples, 'cold');
    const avgWarmLoadMs = average(this.loadSamples, 'warm');
    const { unloadCount, prefetchRequests, prefetchHits, idleUnloadCount, manualUnloadCount } =
      this.metrics;
    const prefetchHitRate = prefetchRequests === 0 ? 0 : prefetchHits / prefetchRequests;
    const estimatedMemoryBytes = this.computeEstimatedMemoryBytes();
    const loadedModels = [...this.modelState.values()].filter((info) => info.loaded).length;
    return {
      avgColdLoadMs,
      avgWarmLoadMs,
      unloadCount,
      prefetchHitRate,
      prefetchRequests,
      prefetchHits,
      idleUnloadCount,
      manualUnloadCount,
      loadedModels,
      pinnedModels: this.pinned.size,
      estimatedMemoryBytes,
    };
  }

  /** Return top prefetch predictions (up to 5) */
  public getPrefetchPredictions(): Prediction[] {
    return this.computePrefetchPredictions();
  }

  /** Update pinned model set (optional runtime adjustment) */
  public setPinnedModels(models: string[]): void {
    this.pinned.clear();
    for (const modelId of models) {
      this.pinned.add(modelId);
      const info = this.ensureModelInfo(modelId);
      info.isPinned = true;
    }
  }

  private initializePinnedState(): void {
    for (const modelId of this.pinned) {
      const info = this.ensureModelInfo(modelId);
      info.isPinned = true;
    }
  }

  private startIdleSweep(): void {
    this.idleSweepTimer = setInterval(() => {
      void this.performIdleSweep();
    }, IDLE_SWEEP_INTERVAL_MS);
  }

  private async performIdleSweep(): Promise<void> {
    if (!this.config.enabled || this.disposed) {
      return;
    }
    const now = Date.now();
    const candidates: string[] = [];

    for (const info of this.modelState.values()) {
      if (!info.loaded || info.isPinned) {
        continue;
      }
      const idleFor = now - info.lastAccessedMs;
      if (idleFor >= this.config.idleTimeoutMs && info.inFlightRequests === 0) {
        candidates.push(info.id);
      }
    }

    for (const modelId of candidates) {
      try {
        await this.executeUnload(modelId, 'idle');
      } catch (error) {
        this.logger?.warn({ modelId, error }, 'Idle unload failed');
      }
    }

    this.cleanupPrefetchRecords(now);
  }

  private cleanupPrefetchRecords(now: number): void {
    for (const [modelId, record] of this.prefetchRecords.entries()) {
      if (record.status !== 'pending' && record.completedAt) {
        const age = now - record.completedAt;
        if (age > PREFETCH_HIT_WINDOW_MS) {
          this.prefetchRecords.delete(modelId);
        }
      }
    }
  }

  private ensureModelInfo(modelId: string): ModelInfo {
    let info = this.modelState.get(modelId);
    if (info) {
      return info;
    }
    info = {
      id: modelId,
      loaded: this.controller.isLoaded?.(modelId) ?? false,
      lastAccessedMs: 0,
      loadCount: 0,
      inFlightRequests: 0,
      isPinned: this.pinned.has(modelId),
      isPrefetching: false,
    };
    this.modelState.set(modelId, info);
    return info;
  }

  private recordAccessHistory(modelId: string): void {
    this.recentAccesses.push(modelId);
    if (this.recentAccesses.length > ACCESS_HISTORY_SIZE) {
      this.recentAccesses.shift();
    }
  }

  private recordTransition(currentModel: string): void {
    const previous = this.lastAccessedModel;
    this.lastAccessedModel = currentModel;
    if (!previous || previous === currentModel) {
      return;
    }
    const transitions = this.transitionGraph.get(previous) ?? new Map<string, TransitionCounter>();
    const counter = transitions.get(currentModel) ?? { count: 0, lastAccessedMs: 0 };
    counter.count += 1;
    counter.lastAccessedMs = Date.now();
    transitions.set(currentModel, counter);
    this.transitionGraph.set(previous, transitions);
    this.transitionTotals.set(previous, (this.transitionTotals.get(previous) ?? 0) + 1);
  }

  private async performLoad(modelId: string, origin: LoadOrigin): Promise<void> {
    if (this.pendingLoads.has(modelId)) {
      await this.pendingLoads.get(modelId);
      return;
    }

    const loadPromise = (async () => {
      const info = this.ensureModelInfo(modelId);
      if (info.loaded) {
        return;
      }
      const previousLoads = info.loadCount;
      info.isPrefetching = origin === 'prefetch';
      const start = Date.now();
      try {
        const handle = await this.controller.loadModel({ model: modelId });
        info.loaded = true;
        info.lastLoadedMs = Date.now();
        info.pendingUnload = undefined;
        info.loadCount = previousLoads + 1;
        if (handle?.metadata) {
          const memoryBytes = this.extractMemoryUsage(handle.metadata);
          if (memoryBytes !== undefined) {
            info.memoryUsageBytes = memoryBytes;
          }
        }
        const type: 'cold' | 'warm' = previousLoads === 0 ? 'cold' : 'warm';
        this.recordLoadSample({
          modelId,
          durationMs: Date.now() - start,
          timestamp: Date.now(),
          type,
          origin,
        });
        const status = this.toModelStatus(info);
        this.emit('modelLoaded', modelId, status, origin);
      } finally {
        info.isPrefetching = false;
      }
    })();

    this.pendingLoads.set(modelId, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.pendingLoads.delete(modelId);
    }
  }

  private extractMemoryUsage(metadata: Record<string, unknown>): number | undefined {
    const candidates = [
      metadata.memory_bytes,
      metadata.gpu_memory_bytes,
      metadata.memoryBytes,
      metadata.gpuMemoryBytes,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private recordLoadSample(sample: LoadTimeSample): void {
    this.loadSamples.push(sample);
    if (this.loadSamples.length > LOAD_SAMPLE_HISTORY_SIZE) {
      this.loadSamples.shift();
    }
  }

  private async enforceCapacity(exemptModelId?: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    const loadedModels = [...this.modelState.values()].filter((info) => info.loaded);
    if (loadedModels.length <= this.config.maxLoadedModels) {
      return;
    }

    const candidates = loadedModels
      .filter((info) => !info.isPinned && info.id !== exemptModelId)
      .sort((a, b) => a.lastAccessedMs - b.lastAccessedMs);

    if (candidates.length === 0) {
      if (!this.loggedPinnedOverflow && loadedModels.length > this.config.maxLoadedModels) {
        this.logger?.warn(
          {
            pinnedCount: this.pinned.size,
            maxLoadedModels: this.config.maxLoadedModels,
          },
          'Pinned models exceed maxLoadedModels; unable to enforce LRU warmups'
        );
        this.loggedPinnedOverflow = true;
      }
      return;
    }

    while (loadedModels.length > this.config.maxLoadedModels && candidates.length > 0) {
      const target = candidates.shift();
      if (!target) {
        break;
      }
      try {
        await this.executeUnload(target.id, 'capacity');
        loadedModels.pop();
      } catch (error) {
        this.logger?.warn({ modelId: target.id, error }, 'Capacity unload failed');
      }
    }
  }

  private async executeUnload(modelId: string, reason: UnloadReason): Promise<void> {
    if (this.pendingUnloads.has(modelId)) {
      await this.pendingUnloads.get(modelId);
      return;
    }

    const unloadPromise = (async () => {
      const info = this.modelState.get(modelId);
      if (!info || !info.loaded) {
        return;
      }
      info.pendingUnload = reason;
      const drained = await this.waitForDrain(modelId);
      if (!drained && reason !== 'manual') {
        this.logger?.warn({ modelId, reason }, 'Drain timeout; forcing unload');
      }
      await this.controller.unloadModel(modelId);
      info.loaded = false;
      info.lastUnloadedMs = Date.now();
      info.pendingUnload = undefined;
      info.isPrefetching = false;
      this.metrics.unloadCount += 1;
      if (reason === 'idle') {
        this.metrics.idleUnloadCount += 1;
      }
      if (reason === 'manual' || reason === 'capacity') {
        this.metrics.manualUnloadCount += 1;
      }
      this.prefetchRecords.delete(modelId);
      this.emit('modelUnloaded', modelId, reason);
    })();

    this.pendingUnloads.set(modelId, unloadPromise);
    try {
      await unloadPromise;
    } finally {
      this.pendingUnloads.delete(modelId);
    }
  }

  private async waitForDrain(modelId: string): Promise<boolean> {
    const info = this.modelState.get(modelId);
    if (!info || info.inFlightRequests === 0) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiters = this.drainWaiters.get(modelId) ?? new Set<DrainResolution>();

      // Declare timeout handle at function scope for proper cleanup
      let timeout: NodeJS.Timeout;

      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        waiters.delete(listener);
        if (waiters.size === 0) {
          this.drainWaiters.delete(modelId);
        }
        resolve(result);
      };

      const listener: DrainResolution = () => {
        if ((this.modelState.get(modelId)?.inFlightRequests ?? 0) === 0) {
          // Clear timeout BEFORE calling finish() for defensive programming
          clearTimeout(timeout);
          finish(true);
        }
      };

      waiters.add(listener);
      this.drainWaiters.set(modelId, waiters);
      timeout = setTimeout(() => finish(false), this.config.drainTimeoutMs);
    });
  }

  private notifyDrainWaiters(modelId: string): void {
    const waiters = this.drainWaiters.get(modelId);
    if (!waiters) {
      return;
    }
    waiters.forEach((resolve) => resolve(true));
    waiters.clear();
    this.drainWaiters.delete(modelId);
  }

  private computePrefetchPredictions(): Prediction[] {
    const predictions: Prediction[] = [];
    const seen = new Set<string>();

    const transitionPredictions = this.buildTransitionPredictions();
    for (const prediction of transitionPredictions) {
      if (predictions.length >= PREFETCH_PREDICTION_LIMIT) {
        break;
      }
      if (seen.has(prediction.modelId)) {
        continue;
      }
      predictions.push(prediction);
      seen.add(prediction.modelId);
    }

    if (predictions.length < PREFETCH_PREDICTION_LIMIT) {
      const frequencyPredictions = this.buildFrequencyPredictions(seen);
      for (const prediction of frequencyPredictions) {
        if (predictions.length >= PREFETCH_PREDICTION_LIMIT) {
          break;
        }
        predictions.push(prediction);
      }
    }

    return predictions;
  }

  private buildTransitionPredictions(): Prediction[] {
    if (!this.lastAccessedModel) {
      return [];
    }
    const transitions = this.transitionGraph.get(this.lastAccessedModel);
    if (!transitions) {
      return [];
    }
    const total = this.transitionTotals.get(this.lastAccessedModel) ?? 0;
    if (total === 0) {
      return [];
    }

    return [...transitions.entries()]
      .map(([modelId, counter]): Prediction => ({
        modelId,
        confidence: counter.count / total,
        source: 'transition',
        lastSeenMs: counter.lastAccessedMs,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  private buildFrequencyPredictions(seen: Set<string>): Prediction[] {
    if (this.recentAccesses.length === 0) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const modelId of this.recentAccesses) {
      counts.set(modelId, (counts.get(modelId) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    if (total === 0) {
      return [];
    }
    return [...counts.entries()]
      .filter(([modelId]) => !seen.has(modelId))
      .map(([modelId, count]): Prediction => ({
        modelId,
        confidence: count / total,
        source: 'recency',
        lastSeenMs: this.modelState.get(modelId)?.lastAccessedMs ?? 0,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  private schedulePrefetchCycle(trigger: PrefetchTrigger): void {
    if (this.prefetchCycleScheduled || !this.config.prefetchEnabled || !this.config.enabled) {
      return;
    }
    this.prefetchCycleScheduled = true;
    queueMicrotask(() => {
      this.prefetchCycleScheduled = false;
      void this.runPrefetchCycle(trigger);
    });
  }

  private async runPrefetchCycle(trigger: PrefetchTrigger): Promise<void> {
    if (
      this.disposed ||
      !this.config.prefetchEnabled ||
      !this.config.enabled ||
      this.globalInFlightRequests > 0
    ) {
      return;
    }

    if (this.prefetchConcurrency >= PREFETCH_MAX_CONCURRENCY) {
      return;
    }

    this.logger?.debug({ trigger }, 'Running prefetch cycle');

    const predictions = this.computePrefetchPredictions()
      .filter((prediction) => prediction.confidence >= this.config.prefetchMinConfidence)
      .filter((prediction) => !this.shouldSkipPrefetch(prediction.modelId));

    if (predictions.length === 0) {
      return;
    }

    const tasks: Promise<void>[] = [];
    for (const prediction of predictions) {
      if (this.prefetchConcurrency >= PREFETCH_MAX_CONCURRENCY) {
        break;
      }
      tasks.push(this.schedulePrefetch(prediction));
    }

    await Promise.all(tasks);
  }

  private shouldSkipPrefetch(modelId: string): boolean {
    const info = this.modelState.get(modelId);
    if (info?.loaded || info?.isPinned) {
      return true;
    }
    if (this.pendingLoads.has(modelId) || this.pendingUnloads.has(modelId)) {
      return true;
    }
    const record = this.prefetchRecords.get(modelId);
    if (record && record.status !== 'failed') {
      return true;
    }
    return false;
  }

  private async schedulePrefetch(prediction: Prediction): Promise<void> {
    this.prefetchConcurrency += 1;
    this.metrics.prefetchRequests += 1;
    const record: PrefetchRecord = {
      modelId: prediction.modelId,
      prediction,
      requestedAt: Date.now(),
      status: 'pending',
    };
    this.prefetchRecords.set(prediction.modelId, record);
    this.emit('prefetchStarted', prediction);

    try {
      await this.performLoad(prediction.modelId, 'prefetch');
      record.status = 'loaded';
      record.completedAt = Date.now();
      this.emit('prefetchCompleted', prediction.modelId, true);
    } catch (error) {
      record.status = 'failed';
      this.prefetchRecords.delete(prediction.modelId);
      this.logger?.debug({ modelId: prediction.modelId, error }, 'Prefetch failed');
      this.emit('prefetchCompleted', prediction.modelId, false);
    } finally {
      this.prefetchConcurrency -= 1;
    }
  }

  private registerPrefetchHit(modelId: string): void {
    const record = this.prefetchRecords.get(modelId);
    if (!record || record.status !== 'loaded' || !record.completedAt) {
      return;
    }
    const age = Date.now() - record.completedAt;
    if (age <= PREFETCH_HIT_WINDOW_MS) {
      this.metrics.prefetchHits += 1;
    }
    this.prefetchRecords.delete(modelId);
  }

  private toModelStatus(info: ModelInfo): ModelStatus {
    return {
      modelId: info.id,
      loaded: info.loaded,
      lastAccessedMs: info.lastAccessedMs,
      lastLoadedMs: info.lastLoadedMs,
      lastUnloadedMs: info.lastUnloadedMs,
      inFlightRequests: info.inFlightRequests,
      isPinned: info.isPinned,
      isPrefetching: info.isPrefetching,
      memoryUsageBytes: info.memoryUsageBytes,
    };
  }

  private computeEstimatedMemoryBytes(): number {
    let total = 0;
    for (const info of this.modelState.values()) {
      if (!info.loaded || typeof info.memoryUsageBytes !== 'number') {
        continue;
      }
      total += info.memoryUsageBytes;
    }
    return total;
  }
}
