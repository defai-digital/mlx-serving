/**
 * Engine Event System
 *
 * Defines event types and payloads for the Engine class.
 */

import type {
  ModelHandle,
  GenerationStats,
  EngineError,
} from '../types/index.js';

/**
 * Event payload when a model is loaded
 */
export interface ModelLoadedEvent {
  modelId: string;
  handle: ModelHandle;
  timestamp: number;
}

/**
 * Event payload when a model is unloaded
 */
export interface ModelUnloadedEvent {
  modelId: string;
  timestamp: number;
}

/**
 * Event payload when generation starts
 */
export interface GenerationStartedEvent {
  streamId: string;
  modelId: string;
  prompt: string;
  timestamp: number;
}

/**
 * Event payload for each generated token
 */
export interface TokenGeneratedEvent {
  streamId: string;
  token: string;
  logprob?: number;
  timestamp: number;
}

/**
 * Event payload when generation completes
 */
export interface GenerationCompletedEvent {
  streamId: string;
  stats: GenerationStats;
  timestamp: number;
}

/**
 * Event payload when an error occurs
 */
export interface ErrorEvent {
  error: EngineError;
  context?: string;
  timestamp: number;
}

/**
 * Event payload for runtime status changes
 */
export interface RuntimeStatusEvent {
  status: 'starting' | 'ready' | 'error' | 'stopped';
  previousStatus?: string;
  timestamp: number;
}

/**
 * Event payload when a model handle becomes invalidated
 * Bug Fix #55 Phase 2: State Synchronization Protocol
 *
 * Emitted when Python runtime restarts or model is forcibly unloaded,
 * notifying users that their ModelHandle references are no longer valid.
 */
export interface ModelInvalidatedEvent {
  modelId: string;
  reason: 'python_restart' | 'unload' | 'error';
  timestamp: number;
}

/**
 * Map of all engine events
 */
export interface EngineEvents {
  'model:loaded': (event: ModelLoadedEvent) => void;
  'model:unloaded': (event: ModelUnloadedEvent) => void;
  'model:invalidated': (event: ModelInvalidatedEvent) => void;
  'generation:started': (event: GenerationStartedEvent) => void;
  'generation:token': (event: TokenGeneratedEvent) => void;
  'generation:completed': (event: GenerationCompletedEvent) => void;
  'error': (event: ErrorEvent) => void;
  'runtime:status': (event: RuntimeStatusEvent) => void;
}

/**
 * Type-safe event emitter helpers
 */
export type EngineEventName = keyof EngineEvents;
export type EngineEventHandler<T extends EngineEventName> = EngineEvents[T];
