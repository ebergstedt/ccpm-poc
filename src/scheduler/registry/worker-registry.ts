/**
 * Worker Registry - Manages worker state and availability
 */

import { WorkerState, WorkerStatus } from '../interfaces/types';

/**
 * WorkerRegistry maintains a Map of worker states for O(1) lookups.
 * Handles worker registration, heartbeats, and availability tracking.
 */
export class WorkerRegistry {
  private workers: Map<string, WorkerState> = new Map();
  private heartbeatTimeoutMs: number;

  constructor(heartbeatTimeoutMs: number = 30000) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  /**
   * Register a new worker or update existing worker state
   */
  register(worker: WorkerState): void {
    this.workers.set(worker.id, {
      ...worker,
      lastHeartbeat: new Date(),
    });
  }

  /**
   * Remove a worker from the registry
   */
  unregister(workerId: string): boolean {
    return this.workers.delete(workerId);
  }

  /**
   * Get worker state by ID
   */
  get(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Update worker heartbeat timestamp
   */
  heartbeat(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    worker.lastHeartbeat = new Date();
    return true;
  }

  /**
   * Update worker status
   */
  updateStatus(workerId: string, status: WorkerStatus): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    worker.status = status;
    return true;
  }

  /**
   * Update worker load
   */
  updateLoad(workerId: string, load: number, activeTasks: number): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    worker.currentLoad = Math.max(0, Math.min(1, load));
    worker.activeTasks = activeTasks;
    return true;
  }

  /**
   * Get all available workers (idle or busy with capacity)
   */
  getAvailable(capabilities?: string[]): WorkerState[] {
    const now = new Date();
    const available: WorkerState[] = [];

    for (const worker of this.workers.values()) {
      // Skip offline or draining workers
      if (worker.status === 'offline' || worker.status === 'draining') {
        continue;
      }

      // Skip workers with stale heartbeat
      if (now.getTime() - worker.lastHeartbeat.getTime() > this.heartbeatTimeoutMs) {
        continue;
      }

      // Skip workers at max capacity
      if (worker.activeTasks >= worker.maxConcurrency) {
        continue;
      }

      // Filter by capabilities if specified
      if (capabilities && capabilities.length > 0) {
        const hasCapabilities = capabilities.every((cap) =>
          worker.capabilities.includes(cap)
        );
        if (!hasCapabilities) {
          continue;
        }
      }

      available.push(worker);
    }

    return available;
  }

  /**
   * Get all registered workers
   */
  getAll(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get count of registered workers
   */
  size(): number {
    return this.workers.size;
  }

  /**
   * Mark stale workers as offline
   */
  pruneStale(): string[] {
    const now = new Date();
    const pruned: string[] = [];

    for (const [id, worker] of this.workers.entries()) {
      if (now.getTime() - worker.lastHeartbeat.getTime() > this.heartbeatTimeoutMs) {
        worker.status = 'offline';
        pruned.push(id);
      }
    }

    return pruned;
  }

  /**
   * Clear all workers from registry
   */
  clear(): void {
    this.workers.clear();
  }
}
