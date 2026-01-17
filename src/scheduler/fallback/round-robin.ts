/**
 * Round-robin fallback scheduler
 */

import { Task, SchedulingDecision, SchedulingReason } from '../interfaces/types';
import { WorkerRegistry } from '../registry/worker-registry';

/**
 * Round-robin scheduler for fallback when ML prediction is unavailable.
 * Distributes tasks evenly across available workers.
 */
export class RoundRobinScheduler {
  private registry: WorkerRegistry;
  private lastIndex: number = -1;

  constructor(registry: WorkerRegistry) {
    this.registry = registry;
  }

  /**
   * Select next worker using round-robin strategy
   *
   * @param task - The task to schedule
   * @param reason - The reason for using fallback
   * @returns Scheduling decision or null if no workers available
   */
  schedule(
    task: Task,
    reason: SchedulingReason = 'fallback_round_robin'
  ): SchedulingDecision | null {
    const capabilities = task.metadata?.requiredCapabilities;
    const available = this.registry.getAvailable(capabilities);

    if (available.length === 0) {
      return null;
    }

    // Round-robin selection
    this.lastIndex = (this.lastIndex + 1) % available.length;
    const selectedWorker = available[this.lastIndex];

    return {
      taskId: task.id,
      workerId: selectedWorker.id,
      timestamp: new Date(),
      usedFallback: true,
      reason,
    };
  }

  /**
   * Select worker with lowest load (weighted round-robin variant)
   */
  scheduleByLoad(
    task: Task,
    reason: SchedulingReason = 'load_balance'
  ): SchedulingDecision | null {
    const capabilities = task.metadata?.requiredCapabilities;
    const available = this.registry.getAvailable(capabilities);

    if (available.length === 0) {
      return null;
    }

    // Sort by load (ascending) and pick the least loaded worker
    const sorted = [...available].sort((a, b) => {
      // Primary: current load
      const loadDiff = a.currentLoad - b.currentLoad;
      if (Math.abs(loadDiff) > 0.01) {
        return loadDiff;
      }
      // Secondary: active tasks ratio
      const ratioA = a.activeTasks / a.maxConcurrency;
      const ratioB = b.activeTasks / b.maxConcurrency;
      return ratioA - ratioB;
    });

    const selectedWorker = sorted[0];

    return {
      taskId: task.id,
      workerId: selectedWorker.id,
      timestamp: new Date(),
      usedFallback: true,
      reason,
    };
  }

  /**
   * Reset round-robin index
   */
  reset(): void {
    this.lastIndex = -1;
  }
}
