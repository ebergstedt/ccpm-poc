/**
 * Availability Calculator - Calculates worker load and estimated availability
 */

import {
  WorkerHeartbeat,
  WorkerHealthStatus,
  WorkerCapacityState,
} from '../interfaces/types';

/**
 * Constants for availability calculations
 */
export const LOAD_WEIGHTS = {
  CPU: 0.6,
  MEMORY: 0.4,
} as const;

export const HEALTH_THRESHOLDS = {
  DEGRADED_LOAD: 0.9,
  UNHEALTHY_TIMEOUT_MS: 30000, // 30 seconds
  REMOVED_TIMEOUT_MS: 300000, // 5 minutes
} as const;

export const DEFAULT_AVG_TASK_DURATION_MS = 5000; // 5 seconds default

/**
 * Calculate current load from CPU and memory usage
 * Formula: currentLoad = 0.6 * cpuUsage + 0.4 * memoryUsage
 */
export function calculateCurrentLoad(cpuUsage: number, memoryUsage: number): number {
  const clampedCpu = Math.max(0, Math.min(1, cpuUsage));
  const clampedMemory = Math.max(0, Math.min(1, memoryUsage));
  return LOAD_WEIGHTS.CPU * clampedCpu + LOAD_WEIGHTS.MEMORY * clampedMemory;
}

/**
 * Calculate estimated time when worker will be available
 * Formula: estimatedAvailableAt = now + (queueDepth * avgTaskDuration)
 */
export function calculateEstimatedAvailableAt(
  queueDepth: number,
  avgTaskDurationMs: number = DEFAULT_AVG_TASK_DURATION_MS,
  now: Date = new Date()
): Date {
  const estimatedWaitMs = queueDepth * avgTaskDurationMs;
  return new Date(now.getTime() + estimatedWaitMs);
}

/**
 * Determine worker health status based on heartbeat and load
 */
export function determineHealthStatus(
  lastHeartbeatMs: number,
  currentLoad: number,
  now: Date = new Date()
): WorkerHealthStatus {
  const timeSinceHeartbeat = now.getTime() - lastHeartbeatMs;

  // Removed: No heartbeat for 5 minutes
  if (timeSinceHeartbeat >= HEALTH_THRESHOLDS.REMOVED_TIMEOUT_MS) {
    return 'removed';
  }

  // Unhealthy: No heartbeat for 30 seconds
  if (timeSinceHeartbeat >= HEALTH_THRESHOLDS.UNHEALTHY_TIMEOUT_MS) {
    return 'unhealthy';
  }

  // Degraded: Heartbeat within 30s but load >= 0.9
  if (currentLoad >= HEALTH_THRESHOLDS.DEGRADED_LOAD) {
    return 'degraded';
  }

  // Healthy: Heartbeat within 30s, load < 0.9
  return 'healthy';
}

/**
 * Check if load change is significant enough to emit an event
 * Returns true if load changed by more than 10%
 */
export function isSignificantLoadChange(
  previousLoad: number,
  currentLoad: number,
  threshold: number = 0.1
): boolean {
  return Math.abs(currentLoad - previousLoad) >= threshold;
}

/**
 * AvailabilityCalculator class for processing heartbeats
 */
export class AvailabilityCalculator {
  private avgTaskDurationMs: number;

  constructor(avgTaskDurationMs: number = DEFAULT_AVG_TASK_DURATION_MS) {
    this.avgTaskDurationMs = avgTaskDurationMs;
  }

  /**
   * Process a heartbeat and return updated capacity state
   */
  processHeartbeat(heartbeat: WorkerHeartbeat): WorkerCapacityState {
    const currentLoad = calculateCurrentLoad(heartbeat.cpuUsage, heartbeat.memoryUsage);
    const healthStatus = determineHealthStatus(heartbeat.timestampMs, currentLoad);
    const estimatedAvailableAt = calculateEstimatedAvailableAt(
      heartbeat.queueDepth,
      this.avgTaskDurationMs
    );

    return {
      queueDepth: heartbeat.queueDepth,
      estimatedAvailableAt,
      healthStatus,
      avgTaskDurationMs: this.avgTaskDurationMs,
    };
  }

  /**
   * Check if a worker should be marked as unhealthy
   */
  shouldMarkUnhealthy(lastHeartbeatMs: number, now: Date = new Date()): boolean {
    const timeSinceHeartbeat = now.getTime() - lastHeartbeatMs;
    return timeSinceHeartbeat >= HEALTH_THRESHOLDS.UNHEALTHY_TIMEOUT_MS;
  }

  /**
   * Check if a worker should be removed
   */
  shouldRemoveWorker(lastHeartbeatMs: number, now: Date = new Date()): boolean {
    const timeSinceHeartbeat = now.getTime() - lastHeartbeatMs;
    return timeSinceHeartbeat >= HEALTH_THRESHOLDS.REMOVED_TIMEOUT_MS;
  }

  /**
   * Update average task duration (for adaptive calculations)
   */
  updateAvgTaskDuration(durationMs: number): void {
    // Exponential moving average with alpha = 0.1
    const alpha = 0.1;
    this.avgTaskDurationMs = alpha * durationMs + (1 - alpha) * this.avgTaskDurationMs;
  }

  /**
   * Get current average task duration
   */
  getAvgTaskDuration(): number {
    return this.avgTaskDurationMs;
  }
}
