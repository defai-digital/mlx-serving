/**
 * HTTP/2 Transport Multiplexing Types
 *
 * Type definitions for HTTP/2 session pooling, stream management,
 * and multiplexed SSE streaming.
 *
 * Phase 4.2 Implementation
 */

import type { ServerHttp2Session, ServerHttp2Stream } from 'http2';

/**
 * HTTP/2 pool configuration
 */
export interface Http2PoolOptions {
  maxSessions: number;
  maxStreamsPerSession: number;
  pingIntervalMs: number;
  connectTimeoutMs: number;
  tls?: {
    caFile?: string;
    certFile?: string;
    keyFile?: string;
    rejectUnauthorized?: boolean;
  };
}

/**
 * Session lifecycle states
 */
export enum SessionState {
  CONNECTING = 'connecting',
  ACTIVE = 'active',
  DRAINING = 'draining',
  CLOSED = 'closed'
}

/**
 * Managed HTTP/2 session
 */
export interface ManagedSession {
  id: string;
  session: ServerHttp2Session;
  state: SessionState;
  activeStreams: number;
  createdAt: number;
  lastPingAt: number;
  lastPongAt: number;
}

/**
 * Multiplexed stream handle
 */
export interface MultiplexedStreamHandle {
  sessionId: string;
  streamId: number;
  stream: ServerHttp2Stream;
  acquiredAt: number;
}

/**
 * HTTP/2 pool statistics
 */
export interface Http2PoolStats {
  totalSessions: number;
  activeSessions: number;
  drainingSessions: number;
  totalStreams: number;
  utilizationPercent: number;
}

/**
 * SSE chunk format
 */
export interface SseChunk {
  event: string;      // e.g., "token", "done", "error"
  id?: string;        // Stream ID for reconnection
  retry?: number;     // Retry timeout in ms
  data: string;       // JSON payload
}

/**
 * WebSocket message protocol
 */
export interface WsMessage {
  type: 'control' | 'data' | 'ping' | 'pong';
  streamId?: string;
  payload: unknown;
}

/**
 * Chunk pool for zero-copy optimization
 */
export interface ChunkPoolOptions {
  maxPoolSize: number;
  chunkSize: number;
}
