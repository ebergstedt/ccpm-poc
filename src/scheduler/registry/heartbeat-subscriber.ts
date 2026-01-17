/**
 * Heartbeat Subscriber - gRPC subscription for worker heartbeats
 */

import { EventEmitter } from 'events';
import {
  WorkerHeartbeat,
  WorkerState,
  WorkerStateEvent,
  WorkerCapacityState,
  WorkerHealthStatus,
} from '../interfaces/types';
import { WorkerRegistry } from './worker-registry';
import {
  AvailabilityCalculator,
  calculateCurrentLoad,
  isSignificantLoadChange,
  HEALTH_THRESHOLDS,
} from './availability-calculator';

/**
 * Configuration for HeartbeatSubscriber
 */
export interface HeartbeatSubscriberConfig {
  unhealthyTimeoutMs?: number;
  removedTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  avgTaskDurationMs?: number;
}

const DEFAULT_CONFIG: Required<HeartbeatSubscriberConfig> = {
  unhealthyTimeoutMs: HEALTH_THRESHOLDS.UNHEALTHY_TIMEOUT_MS,
  removedTimeoutMs: HEALTH_THRESHOLDS.REMOVED_TIMEOUT_MS,
  healthCheckIntervalMs: 5000,
  avgTaskDurationMs: 5000,
};

/**
 * Extended worker state with capacity tracking
 */
interface ExtendedWorkerState {
  capacity: WorkerCapacityState;
  previousLoad: number;
}

/**
 * Mock gRPC stream interface for dependency injection
 */
export interface GrpcHeartbeatStream {
  on(event: 'data', callback: (heartbeat: WorkerHeartbeat) => void): this;
  on(event: 'error', callback: (error: Error) => void): this;
  on(event: 'end', callback: () => void): this;
  cancel(): void;
}

/**
 * HeartbeatSubscriber manages gRPC heartbeat subscriptions and updates worker state
 */
export class HeartbeatSubscriber extends EventEmitter {
  private registry: WorkerRegistry;
  private calculator: AvailabilityCalculator;
  private config: Required<HeartbeatSubscriberConfig>;
  private workerCapacity: Map<string, ExtendedWorkerState>;
  private stream: GrpcHeartbeatStream | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(
    registry: WorkerRegistry,
    config: HeartbeatSubscriberConfig = {}
  ) {
    super();
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.calculator = new AvailabilityCalculator({
      avgTaskDurationMs: this.config.avgTaskDurationMs,
      unhealthyTimeoutMs: this.config.unhealthyTimeoutMs,
      removedTimeoutMs: this.config.removedTimeoutMs,
    });
    this.workerCapacity = new Map();
  }

  /**
   * Subscribe to a gRPC heartbeat stream
   */
  subscribe(stream: GrpcHeartbeatStream): void {
    if (this.stream) {
      this.unsubscribe();
    }

    this.stream = stream;
    this.isRunning = true;

    stream.on('data', (heartbeat: WorkerHeartbeat) => {
      this.handleHeartbeat(heartbeat);
    });

    stream.on('error', (error: Error) => {
      this.emit('error', error);
    });

    stream.on('end', () => {
      this.isRunning = false;
      this.emit('streamEnd');
    });

    // Start health check interval
    this.startHealthCheck();
  }

  /**
   * Unsubscribe from the current stream
   */
  unsubscribe(): void {
    if (this.stream) {
      this.stream.cancel();
      this.stream = null;
    }

    this.stopHealthCheck();
    this.isRunning = false;
  }

  /**
   * Handle incoming heartbeat
   */
  private handleHeartbeat(heartbeat: WorkerHeartbeat): void {
    const workerId = heartbeat.workerId;
    const worker = this.registry.get(workerId);

    if (!worker) {
      // Unknown worker, skip
      return;
    }

    // Calculate new capacity state
    const capacityState = this.calculator.processHeartbeat(heartbeat);
    const currentLoad = calculateCurrentLoad(heartbeat.cpuUsage, heartbeat.memoryUsage);

    // Get previous state
    const previousState = this.workerCapacity.get(workerId);
    const previousLoad = previousState?.previousLoad ?? currentLoad;
    const previousHealth = previousState?.capacity.healthStatus ?? 'healthy';

    // Update worker state in registry
    this.registry.heartbeat(workerId);
    this.registry.updateLoad(workerId, currentLoad, worker.activeTasks);

    // Store updated capacity
    this.workerCapacity.set(workerId, {
      capacity: capacityState,
      previousLoad: currentLoad,
    });

    // Emit events for significant state changes
    this.emitStateChanges(workerId, previousHealth, capacityState.healthStatus, previousLoad, currentLoad);
  }

  /**
   * Emit events when worker state changes significantly
   */
  private emitStateChanges(
    workerId: string,
    previousHealth: WorkerHealthStatus,
    currentHealth: WorkerHealthStatus,
    previousLoad: number,
    currentLoad: number
  ): void {
    // Health status changed
    if (previousHealth !== currentHealth) {
      switch (currentHealth) {
        case 'healthy':
          this.emit('workerStateChange', {
            type: 'worker_healthy',
            workerId,
          } as WorkerStateEvent);
          break;
        case 'degraded':
          this.emit('workerStateChange', {
            type: 'worker_degraded',
            workerId,
            load: currentLoad,
          } as WorkerStateEvent);
          break;
        case 'unhealthy':
          const worker = this.registry.get(workerId);
          this.emit('workerStateChange', {
            type: 'worker_unhealthy',
            workerId,
            lastHeartbeat: worker?.lastHeartbeat ?? new Date(),
          } as WorkerStateEvent);
          break;
        case 'removed':
          this.emit('workerStateChange', {
            type: 'worker_removed',
            workerId,
          } as WorkerStateEvent);
          break;
      }
    }

    // Significant load change (>10%)
    if (isSignificantLoadChange(previousLoad, currentLoad)) {
      this.emit('workerStateChange', {
        type: 'worker_load_changed',
        workerId,
        previousLoad,
        currentLoad,
      } as WorkerStateEvent);
    }
  }

  /**
   * Start periodic health check for all workers
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      this.checkWorkerHealth();
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Stop periodic health check
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check health of all workers
   */
  private checkWorkerHealth(): void {
    const now = new Date();
    const workers = this.registry.getAll();

    for (const worker of workers) {
      const lastHeartbeatMs = worker.lastHeartbeat.getTime();
      const workerId = worker.id;

      // Check if worker should be removed (5 minutes)
      if (this.calculator.shouldRemoveWorker(lastHeartbeatMs, now)) {
        this.handleWorkerRemoval(workerId);
        continue;
      }

      // Check if worker should be marked unhealthy (30 seconds)
      if (this.calculator.shouldMarkUnhealthy(lastHeartbeatMs, now)) {
        this.handleWorkerUnhealthy(workerId, worker);
      }
    }
  }

  /**
   * Handle worker that should be removed
   */
  private handleWorkerRemoval(workerId: string): void {
    const previousState = this.workerCapacity.get(workerId);
    const previousHealth = previousState?.capacity.healthStatus ?? 'healthy';

    if (previousHealth !== 'removed') {
      // Emit removal event
      this.emit('workerStateChange', {
        type: 'worker_removed',
        workerId,
      } as WorkerStateEvent);

      // Update capacity state
      if (previousState) {
        previousState.capacity.healthStatus = 'removed';
      }
    }

    // Remove from registry
    this.registry.unregister(workerId);
    this.workerCapacity.delete(workerId);
  }

  /**
   * Handle worker that should be marked unhealthy
   */
  private handleWorkerUnhealthy(workerId: string, worker: WorkerState): void {
    const previousState = this.workerCapacity.get(workerId);
    const previousHealth = previousState?.capacity.healthStatus ?? 'healthy';

    if (previousHealth !== 'unhealthy' && previousHealth !== 'removed') {
      // Update registry status
      this.registry.updateStatus(workerId, 'offline');

      // Emit unhealthy event
      this.emit('workerStateChange', {
        type: 'worker_unhealthy',
        workerId,
        lastHeartbeat: worker.lastHeartbeat,
      } as WorkerStateEvent);

      // Update capacity state
      if (previousState) {
        previousState.capacity.healthStatus = 'unhealthy';
      } else {
        this.workerCapacity.set(workerId, {
          capacity: {
            queueDepth: 0,
            estimatedAvailableAt: null,
            healthStatus: 'unhealthy',
            avgTaskDurationMs: this.config.avgTaskDurationMs,
          },
          previousLoad: worker.currentLoad,
        });
      }
    }
  }

  /**
   * Get capacity state for a worker
   */
  getWorkerCapacity(workerId: string): WorkerCapacityState | undefined {
    return this.workerCapacity.get(workerId)?.capacity;
  }

  /**
   * Get all workers with their capacity states
   */
  getAllWorkerCapacities(): Map<string, WorkerCapacityState> {
    const result = new Map<string, WorkerCapacityState>();
    for (const [workerId, state] of this.workerCapacity) {
      result.set(workerId, state.capacity);
    }
    return result;
  }

  /**
   * Check if subscriber is running
   */
  isSubscribed(): boolean {
    return this.isRunning;
  }

  /**
   * Get the availability calculator instance
   */
  getCalculator(): AvailabilityCalculator {
    return this.calculator;
  }
}
