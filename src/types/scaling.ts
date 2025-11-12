/**
 * Horizontal Scaling Types (Week 3)
 *
 * Types for multi-instance deployment with load balancing and distributed caching.
 */

/**
 * Load balancing strategy
 */
export enum LoadBalancingStrategy {
  /** Simple round-robin distribution */
  ROUND_ROBIN = 'round-robin',

  /** Route to instance with lowest current load */
  LEAST_LOADED = 'least-loaded',

  /** Route to instance with lowest estimated latency */
  LATENCY_AWARE = 'latency-aware',

  /** Consistent hashing for session affinity */
  CONSISTENT_HASH = 'consistent-hash',
}

/**
 * Instance health status
 */
export enum HealthStatus {
  /** Instance is healthy and accepting requests */
  HEALTHY = 'healthy',

  /** Instance is degraded but still functional */
  DEGRADED = 'degraded',

  /** Instance is unhealthy and should not receive traffic */
  UNHEALTHY = 'unhealthy',

  /** Instance health is unknown (not yet checked) */
  UNKNOWN = 'unknown',
}

/**
 * Circuit breaker state
 */
export enum CircuitState {
  /** Circuit is closed, requests flow normally */
  CLOSED = 'closed',

  /** Circuit is open, requests are rejected */
  OPEN = 'open',

  /** Circuit is half-open, testing if instance recovered */
  HALF_OPEN = 'half-open',
}

/**
 * Instance information
 */
export interface InstanceInfo {
  /** Unique instance identifier */
  id: string;

  /** Instance endpoint (URL or address) */
  endpoint: string;

  /** Maximum throughput capacity (tokens/second) */
  capacity: number;

  /** Current load (tokens/second) */
  currentLoad: number;

  /** Health status */
  health: HealthStatus;

  /** Average latency in milliseconds */
  avgLatencyMs: number;

  /** Circuit breaker state */
  circuitState: CircuitState;

  /** Number of consecutive failures */
  consecutiveFailures: number;

  /** Last health check timestamp */
  lastHealthCheck: number;

  /** Instance metadata (model, GPU type, etc.) */
  metadata: InstanceMetadata;
}

/**
 * Instance metadata
 */
export interface InstanceMetadata {
  /** Loaded model name */
  model?: string;

  /** GPU type (M3, M4 Pro, M4 Max, M4 Ultra) */
  gpuType?: string;

  /** Total GPU memory in GB */
  gpuMemoryGb?: number;

  /** Available GPU memory in GB */
  availableMemoryGb?: number;

  /** Instance version */
  version?: string;

  /** Instance region/zone */
  region?: string;

  /** Custom tags */
  tags?: Record<string, string>;
}

/**
 * Load balancer configuration
 */
export interface LoadBalancerConfig {
  /** Load balancing strategy */
  strategy: LoadBalancingStrategy;

  /** Health check interval in milliseconds */
  healthCheckIntervalMs: number;

  /** Health check timeout in milliseconds */
  healthCheckTimeoutMs: number;

  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfig;

  /** Maximum retries for failed requests */
  maxRetries: number;

  /** Retry delay in milliseconds */
  retryDelayMs: number;

  /** Enable request timeout */
  enableTimeout: boolean;

  /** Request timeout in milliseconds */
  requestTimeoutMs: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Enable circuit breaker */
  enabled: boolean;

  /** Number of failures before opening circuit */
  failureThreshold: number;

  /** Time window for counting failures (milliseconds) */
  failureWindowMs: number;

  /** Time to wait before half-open attempt (milliseconds) */
  resetTimeoutMs: number;

  /** Number of successful requests to close circuit */
  successThreshold: number;
}

/**
 * Routing decision
 */
export interface RoutingDecision {
  /** Selected instance */
  instance: InstanceInfo;

  /** Routing reason (for debugging) */
  reason: string;

  /** Estimated latency in milliseconds */
  estimatedLatencyMs: number;

  /** Alternative instances (fallback options) */
  alternatives: InstanceInfo[];
}

/**
 * Load balancer metrics
 */
export interface LoadBalancerMetrics {
  /** Total requests routed */
  totalRequests: number;

  /** Total failures */
  totalFailures: number;

  /** Requests per instance */
  requestsPerInstance: Record<string, number>;

  /** Failures per instance */
  failuresPerInstance: Record<string, number>;

  /** Average latency per instance (milliseconds) */
  avgLatencyPerInstance: Record<string, number>;

  /** Current strategy */
  strategy: LoadBalancingStrategy;

  /** Number of healthy instances */
  healthyInstances: number;

  /** Number of degraded instances */
  degradedInstances: number;

  /** Number of unhealthy instances */
  unhealthyInstances: number;

  /** Total capacity (tokens/second) */
  totalCapacity: number;

  /** Total current load (tokens/second) */
  totalLoad: number;

  /** Overall utilization (0-1) */
  utilization: number;
}

/**
 * Distributed cache configuration
 */
export interface DistributedCacheConfig {
  /** Enable distributed cache */
  enabled: boolean;

  /** Redis connection URL */
  redisUrl?: string;

  /** Cache key prefix */
  keyPrefix: string;

  /** Default TTL in seconds */
  defaultTtlSeconds: number;

  /** Maximum cache size in bytes */
  maxSizeBytes: number;

  /** Enable compression for large values */
  enableCompression: boolean;

  /** Compression threshold in bytes */
  compressionThresholdBytes: number;

  /** Enable local cache fallback */
  enableLocalFallback: boolean;

  /** Local cache size (number of entries) */
  localCacheSize: number;

  /** Connection timeout in milliseconds */
  connectionTimeoutMs: number;

  /** Command timeout in milliseconds */
  commandTimeoutMs: number;
}

/**
 * Cache entry
 */
export interface CacheEntry<T = unknown> {
  /** Cache key */
  key: string;

  /** Cache value */
  value: T;

  /** TTL in seconds */
  ttl: number;

  /** Timestamp when entry was created */
  createdAt: number;

  /** Size in bytes */
  sizeBytes: number;

  /** Is compressed */
  compressed: boolean;
}

/**
 * Cache metrics
 */
export interface CacheMetrics {
  /** Total cache hits */
  hits: number;

  /** Total cache misses */
  misses: number;

  /** Hit rate (0-1) */
  hitRate: number;

  /** Total cache entries */
  entries: number;

  /** Total cache size in bytes */
  sizeBytes: number;

  /** Average entry size in bytes */
  avgEntrySizeBytes: number;

  /** Cache type (distributed or local) */
  type: 'distributed' | 'local' | 'hybrid';

  /** Redis connection status */
  redisConnected?: boolean;

  /** Fallback to local cache count */
  localFallbackCount?: number;
}

/**
 * Instance registry configuration
 */
export interface InstanceRegistryConfig {
  /** Auto-discovery enabled */
  autoDiscovery: boolean;

  /** Discovery interval in milliseconds */
  discoveryIntervalMs: number;

  /** Instance timeout (remove after no heartbeat) */
  instanceTimeoutMs: number;

  /** Enable auto-scaling triggers */
  enableAutoScaling: boolean;

  /** Auto-scaling thresholds */
  autoScaling: AutoScalingConfig;

  /** Enable Prometheus metrics export */
  enablePrometheusMetrics: boolean;

  /** Metrics export port */
  metricsPort: number;
}

/**
 * Auto-scaling configuration
 */
export interface AutoScalingConfig {
  /** Minimum number of instances */
  minInstances: number;

  /** Maximum number of instances */
  maxInstances: number;

  /** Target utilization (0-1) */
  targetUtilization: number;

  /** Scale up threshold (0-1) */
  scaleUpThreshold: number;

  /** Scale down threshold (0-1) */
  scaleDownThreshold: number;

  /** Cooldown period after scale up (milliseconds) */
  scaleUpCooldownMs: number;

  /** Cooldown period after scale down (milliseconds) */
  scaleDownCooldownMs: number;
}

/**
 * Scaling event
 */
export interface ScalingEvent {
  /** Event type */
  type: 'scale-up' | 'scale-down' | 'instance-added' | 'instance-removed';

  /** Timestamp */
  timestamp: number;

  /** Current instance count */
  instanceCount: number;

  /** Current utilization (0-1) */
  utilization: number;

  /** Trigger reason */
  reason: string;

  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Registry metrics
 */
export interface RegistryMetrics {
  /** Total registered instances */
  totalInstances: number;

  /** Healthy instances */
  healthyInstances: number;

  /** Degraded instances */
  degradedInstances: number;

  /** Unhealthy instances */
  unhealthyInstances: number;

  /** Total capacity (tokens/second) */
  totalCapacity: number;

  /** Total load (tokens/second) */
  totalLoad: number;

  /** Average utilization (0-1) */
  avgUtilization: number;

  /** Scaling events in last hour */
  scalingEventsLastHour: number;

  /** Last scaling event */
  lastScalingEvent?: ScalingEvent;
}

/**
 * Horizontal scaling configuration (runtime.yaml)
 */
export interface HorizontalScalingConfig {
  /** Enable horizontal scaling */
  enabled: boolean;

  /** Load balancer configuration */
  loadBalancer: LoadBalancerConfig;

  /** Distributed cache configuration */
  distributedCache: DistributedCacheConfig;

  /** Instance registry configuration */
  instanceRegistry: InstanceRegistryConfig;
}
