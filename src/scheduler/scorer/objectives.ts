/**
 * Individual objective functions for multi-objective scoring
 */

import { WorkerState, TaskPrediction } from '../interfaces/types';

/**
 * Default maximum values for normalization
 */
export const DEFAULT_MAX_WAIT_MS = 60000; // 60 seconds
export const DEFAULT_MAX_PRIORITY = 10;

/**
 * Calculate wait time score (higher = better)
 * Score decreases as estimated wait increases
 *
 * @param estimatedWaitMs - Estimated wait time in milliseconds
 * @param maxWaitMs - Maximum expected wait time for normalization
 * @returns Score between 0 and 1
 */
export function calculateWaitScore(
  estimatedWaitMs: number,
  maxWaitMs: number = DEFAULT_MAX_WAIT_MS
): number {
  if (estimatedWaitMs <= 0) return 1;
  if (estimatedWaitMs >= maxWaitMs) return 0;
  return 1 - estimatedWaitMs / maxWaitMs;
}

/**
 * Calculate load score (higher = better)
 * Prefers workers with lower current load
 *
 * @param currentLoad - Worker's current load (0-1)
 * @returns Score between 0 and 1
 */
export function calculateLoadScore(currentLoad: number): number {
  const clampedLoad = Math.max(0, Math.min(1, currentLoad));
  return 1 - clampedLoad;
}

/**
 * Calculate priority score (higher = better)
 * Higher priority tasks get higher scores
 *
 * @param priority - Task priority
 * @param maxPriority - Maximum priority for normalization
 * @returns Score between 0 and 1
 */
export function calculatePriorityScore(
  priority: number,
  maxPriority: number = DEFAULT_MAX_PRIORITY
): number {
  if (priority <= 0) return 0;
  if (priority >= maxPriority) return 1;
  return priority / maxPriority;
}

/**
 * Estimate wait time for a worker based on queue depth and prediction
 *
 * @param worker - Worker state
 * @param prediction - Task duration prediction
 * @returns Estimated wait time in milliseconds
 */
export function estimateWaitTime(
  worker: WorkerState,
  prediction: TaskPrediction | null
): number {
  const estimatedDuration = prediction?.estimatedDurationMs ?? 5000;
  return worker.activeTasks * estimatedDuration;
}

/**
 * Check if worker is eligible for task assignment
 *
 * @param worker - Worker state
 * @param requiredCapabilities - Required capabilities (optional)
 * @returns Whether worker can handle the task
 */
export function isWorkerEligible(
  worker: WorkerState,
  requiredCapabilities?: string[]
): boolean {
  // Must not be offline or draining
  if (worker.status === 'offline' || worker.status === 'draining') {
    return false;
  }

  // Must have capacity
  if (worker.activeTasks >= worker.maxConcurrency) {
    return false;
  }

  // Check capabilities if specified
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    return requiredCapabilities.every((cap) =>
      worker.capabilities.includes(cap)
    );
  }

  return true;
}
