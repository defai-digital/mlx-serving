/**
 * Scheduling types for Week 3 Priority Scheduler
 *
 * Defines priority levels, SLA configurations, scheduling policies,
 * and request metadata for advanced request scheduling.
 */

/**
 * Request priority levels
 *
 * Priority determines queue ordering and preemption decisions:
 * - CRITICAL: <100ms SLA (interactive/real-time UI)
 * - HIGH: <500ms SLA (API calls, critical operations)
 * - NORMAL: <2s SLA (standard requests)
 * - LOW: <10s SLA (background processing)
 * - BACKGROUND: Best-effort (no SLA guarantee)
 */
export enum PriorityLevel {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
  BACKGROUND = 4,
}

/**
 * SLA (Service Level Agreement) configuration
 *
 * Defines performance expectations for requests.
 */
export interface SlaConfig {
  /**
   * Target response time in milliseconds
   */
  targetLatencyMs: number;

  /**
   * Maximum acceptable response time before SLA violation
   */
  maxLatencyMs: number;

  /**
   * Acceptable violation rate (0-1)
   * Example: 0.01 = 1% of requests may violate SLA
   */
  violationThreshold: number;
}

/**
 * SLA configuration by priority level
 */
export interface SlaTiers {
  [PriorityLevel.CRITICAL]: SlaConfig;
  [PriorityLevel.HIGH]: SlaConfig;
  [PriorityLevel.NORMAL]: SlaConfig;
  [PriorityLevel.LOW]: SlaConfig;
  [PriorityLevel.BACKGROUND]: SlaConfig;
}

/**
 * Scheduling policy configuration
 *
 * Defines how requests are selected and scheduled.
 */
export interface SchedulingPolicy {
  /**
   * Enable shortest-job-first optimization within priority tiers
   * @default true
   */
  shortestJobFirst: boolean;

  /**
   * Enable preemption (interrupt long-running requests for high-priority)
   * @default false
   */
  allowPreemption: boolean;

  /**
   * Fair queuing weight (prevent starvation of low-priority requests)
   * Value 0-1: how often to promote low-priority requests
   * @default 0.1 (10% of scheduling decisions favor fairness)
   */
  fairnessWeight: number;

  /**
   * Urgency threshold in milliseconds
   * Requests within this time to deadline are treated as urgent
   * @default 100
   */
  urgencyThresholdMs: number;

  /**
   * Enable dynamic priority adjustment based on wait time
   * @default true
   */
  agingEnabled: boolean;

  /**
   * Time in milliseconds before a request's priority is bumped
   * @default 5000 (5 seconds)
   */
  agingIntervalMs: number;
}

/**
 * Request metadata for scheduling decisions
 *
 * Attached to each request to enable SLA-aware scheduling.
 */
export interface RequestMetadata {
  /**
   * Unique request identifier
   */
  id: string;

  /**
   * Request priority level
   */
  priority: PriorityLevel;

  /**
   * Timestamp when request was queued (milliseconds since epoch)
   */
  queuedAt: number;

  /**
   * Estimated number of tokens to generate
   * Used for shortest-job-first optimization
   */
  estimatedTokens?: number;

  /**
   * SLA deadline timestamp (milliseconds since epoch)
   * If undefined, uses default SLA for priority level
   */
  deadline?: number;

  /**
   * Original priority (before aging adjustments)
   */
  originalPriority: PriorityLevel;

  /**
   * Number of times priority has been bumped due to aging
   */
  agingBumps: number;

  /**
   * Tenant/user identifier for fair queuing across tenants
   */
  tenantId?: string;

  /**
   * Custom metadata (application-specific)
   */
  customData?: Record<string, unknown>;
}

/**
 * Schedulable request wrapper
 *
 * Wraps a request with metadata for priority scheduling.
 */
export interface SchedulableRequest<T = unknown> {
  /**
   * Request metadata
   */
  metadata: RequestMetadata;

  /**
   * Original request payload
   */
  payload: T;

  /**
   * Promise resolve function
   */
  resolve: (result: unknown) => void;

  /**
   * Promise reject function
   */
  reject: (error: Error) => void;
}

/**
 * Preemption decision
 */
export interface PreemptionDecision {
  /**
   * Whether to preempt the current request
   */
  shouldPreempt: boolean;

  /**
   * Reason for preemption decision
   */
  reason?: string;

  /**
   * Request to preempt (if shouldPreempt is true)
   */
  requestToPreempt?: SchedulableRequest;

  /**
   * New request triggering preemption
   */
  newRequest?: SchedulableRequest;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  /**
   * Total requests in queue by priority
   */
  queueDepth: Record<PriorityLevel, number>;

  /**
   * Current queue size (all priorities)
   */
  totalQueueSize: number;

  /**
   * Oldest request age by priority (milliseconds)
   */
  oldestRequestAge: Record<PriorityLevel, number>;

  /**
   * Requests currently executing
   */
  executing: number;

  /**
   * Requests preempted (waiting to resume)
   */
  preempted: number;
}

/**
 * Scheduling decision
 */
export interface SchedulingDecision {
  /**
   * Selected request to execute
   */
  request: SchedulableRequest | null;

  /**
   * Reason for selection
   */
  reason: string;

  /**
   * Queue state before selection
   */
  queueStateBefore: QueueStats;

  /**
   * Timestamp of decision
   */
  timestamp: number;
}

/**
 * Fair queuing state (per-tenant tracking)
 */
export interface FairQueuingState {
  /**
   * Number of requests served per tenant
   */
  servedCounts: Map<string, number>;

  /**
   * Last served timestamp per tenant
   */
  lastServed: Map<string, number>;

  /**
   * Current queue depth per tenant
   */
  tenantQueueDepth: Map<string, number>;
}

/**
 * Priority scheduler configuration
 */
export interface PrioritySchedulerConfig {
  /**
   * SLA tiers by priority level
   */
  slaTiers: SlaTiers;

  /**
   * Scheduling policy
   */
  policy: SchedulingPolicy;

  /**
   * Maximum queue size (total across all priorities)
   * @default 1000
   */
  maxQueueSize: number;

  /**
   * Maximum requests executing concurrently
   * @default 10
   */
  maxConcurrent: number;

  /**
   * Enable metrics collection
   * @default true
   */
  enableMetrics: boolean;

  /**
   * Logger instance (optional)
   */
  logger?: unknown;
}
