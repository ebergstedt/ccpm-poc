/**
 * Core types for the Nexus Scheduler
 */

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  redisUrl: string;
  fallbackThreshold: number; // Default: 3
  heartbeatTimeoutMs: number; // Default: 30000
}

/**
 * Default configuration values
 */
export const DEFAULT_SCHEDULER_CONFIG: Partial<SchedulerConfig> = {
  fallbackThreshold: 3,
  heartbeatTimeoutMs: 30000,
};

/**
 * Task definition submitted for scheduling
 */
export interface Task {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  createdAt: Date;
  metadata?: TaskMetadata;
}

/**
 * Optional task metadata for scheduling decisions
 */
export interface TaskMetadata {
  estimatedDurationMs?: number;
  requiredCapabilities?: string[];
  maxRetries?: number;
  timeout?: number;
}

/**
 * Prediction result from the ML predictor
 */
export interface TaskPrediction {
  taskId: string;
  recommendedWorkerId: string;
  confidence: number; // 0.0 - 1.0
  estimatedDurationMs: number;
  alternativeWorkers?: string[];
}

/**
 * Worker availability states
 */
export type WorkerStatus = 'idle' | 'busy' | 'draining' | 'offline';

/**
 * Worker state tracked by the registry
 */
export interface WorkerState {
  id: string;
  status: WorkerStatus;
  capabilities: string[];
  currentLoad: number; // 0.0 - 1.0
  lastHeartbeat: Date;
  activeTasks: number;
  maxConcurrency: number;
  metadata?: WorkerMetadata;
}

/**
 * Optional worker metadata
 */
export interface WorkerMetadata {
  hostname?: string;
  version?: string;
  startedAt?: Date;
  tags?: string[];
}

/**
 * Scheduling decision output
 */
export interface SchedulingDecision {
  taskId: string;
  workerId: string;
  timestamp: Date;
  usedFallback: boolean;
  prediction?: TaskPrediction;
  reason: SchedulingReason;
}

/**
 * Reason for scheduling decision
 */
export type SchedulingReason =
  | 'prediction'
  | 'fallback_round_robin'
  | 'fallback_circuit_breaker'
  | 'capability_match'
  | 'load_balance';

/**
 * Dispatch result
 */
export interface DispatchResult {
  success: boolean;
  decision: SchedulingDecision;
  error?: string;
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  failures: number;
  lastFailure: Date | null;
  isOpen: boolean;
}

/**
 * Redis stream message format
 */
export interface StreamMessage {
  id: string;
  task: Task;
}
