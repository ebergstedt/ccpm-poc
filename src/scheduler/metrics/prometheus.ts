/**
 * Prometheus Metrics Client for Nexus Scheduler
 *
 * Exposes metrics for monitoring scheduling decisions, latency,
 * worker health, and prediction accuracy.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Metrics configuration options
 */
export interface MetricsConfig {
  /** Prefix for all metric names */
  prefix?: string;
  /** Custom labels to add to all metrics */
  defaultLabels?: Record<string, string>;
  /** Whether to collect default Node.js metrics */
  collectDefaultMetrics?: boolean;
  /** Buckets for latency histogram (in ms) */
  latencyBuckets?: number[];
  /** Buckets for prediction accuracy ratio */
  accuracyBuckets?: number[];
}

/**
 * Default metrics configuration
 */
export const DEFAULT_METRICS_CONFIG: Required<MetricsConfig> = {
  prefix: 'scheduler_',
  defaultLabels: {},
  collectDefaultMetrics: true,
  latencyBuckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  accuracyBuckets: [0.1, 0.25, 0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0],
};

/**
 * Decision status for counter labels
 */
export type DecisionStatus = 'success' | 'fallback' | 'error';

/**
 * Worker health status for gauge labels
 */
export type WorkerHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Prometheus metrics manager for the scheduler
 */
export class SchedulerMetrics {
  private registry: Registry;
  private config: Required<MetricsConfig>;

  /** Counter: Total scheduling decisions */
  public readonly decisionsTotal: Counter<'status'>;

  /** Histogram: Scheduling decision latency in milliseconds */
  public readonly decisionLatency: Histogram<'status'>;

  /** Gauge: Number of active workers by health status */
  public readonly workersActive: Gauge<'status'>;

  /** Histogram: Prediction accuracy ratio (predicted/actual) */
  public readonly predictionAccuracy: Histogram<string>;

  /** Counter: Total tasks dispatched */
  public readonly tasksDispatched: Counter<'task_type' | 'worker_id'>;

  /** Counter: Total dispatch errors */
  public readonly dispatchErrors: Counter<'error_type'>;

  /** Gauge: Current queue depth */
  public readonly queueDepth: Gauge<string>;

  /** Histogram: Time spent in queue (ms) */
  public readonly queueWaitTime: Histogram<string>;

  constructor(config: MetricsConfig = {}) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config };
    this.registry = new Registry();

    // Set default labels if provided
    if (Object.keys(this.config.defaultLabels).length > 0) {
      this.registry.setDefaultLabels(this.config.defaultLabels);
    }

    // Collect default Node.js metrics if enabled
    if (this.config.collectDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }

    const prefix = this.config.prefix;

    // Initialize metrics

    this.decisionsTotal = new Counter({
      name: `${prefix}decisions_total`,
      help: 'Total number of scheduling decisions made',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.decisionLatency = new Histogram({
      name: `${prefix}decision_latency_ms`,
      help: 'Scheduling decision latency in milliseconds',
      labelNames: ['status'] as const,
      buckets: this.config.latencyBuckets,
      registers: [this.registry],
    });

    this.workersActive = new Gauge({
      name: `${prefix}workers_active`,
      help: 'Number of active workers by health status',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.predictionAccuracy = new Histogram({
      name: `${prefix}prediction_accuracy_ratio`,
      help: 'Ratio of predicted duration to actual duration (1.0 = perfect)',
      buckets: this.config.accuracyBuckets,
      registers: [this.registry],
    });

    this.tasksDispatched = new Counter({
      name: `${prefix}tasks_dispatched_total`,
      help: 'Total number of tasks dispatched to workers',
      labelNames: ['task_type', 'worker_id'] as const,
      registers: [this.registry],
    });

    this.dispatchErrors = new Counter({
      name: `${prefix}dispatch_errors_total`,
      help: 'Total number of dispatch errors',
      labelNames: ['error_type'] as const,
      registers: [this.registry],
    });

    this.queueDepth = new Gauge({
      name: `${prefix}queue_depth`,
      help: 'Current number of tasks in the queue',
      registers: [this.registry],
    });

    this.queueWaitTime = new Histogram({
      name: `${prefix}queue_wait_time_ms`,
      help: 'Time tasks spend waiting in the queue (ms)',
      buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000],
      registers: [this.registry],
    });
  }

  /**
   * Record a scheduling decision
   */
  recordDecision(status: DecisionStatus, latencyMs: number): void {
    this.decisionsTotal.inc({ status });
    this.decisionLatency.observe({ status }, latencyMs);
  }

  /**
   * Record a task dispatch
   */
  recordDispatch(taskType: string, workerId: string): void {
    this.tasksDispatched.inc({ task_type: taskType, worker_id: workerId });
  }

  /**
   * Record a dispatch error
   */
  recordDispatchError(errorType: string): void {
    this.dispatchErrors.inc({ error_type: errorType });
  }

  /**
   * Update worker counts by health status
   */
  updateWorkerCounts(
    healthy: number,
    degraded: number,
    unhealthy: number
  ): void {
    this.workersActive.set({ status: 'healthy' }, healthy);
    this.workersActive.set({ status: 'degraded' }, degraded);
    this.workersActive.set({ status: 'unhealthy' }, unhealthy);
  }

  /**
   * Record prediction accuracy
   * @param predictedMs Predicted duration in milliseconds
   * @param actualMs Actual duration in milliseconds
   */
  recordPredictionAccuracy(predictedMs: number, actualMs: number): void {
    if (actualMs > 0) {
      const ratio = predictedMs / actualMs;
      this.predictionAccuracy.observe(ratio);
    }
  }

  /**
   * Update queue depth
   */
  updateQueueDepth(depth: number): void {
    this.queueDepth.set(depth);
  }

  /**
   * Record queue wait time
   */
  recordQueueWaitTime(waitTimeMs: number): void {
    this.queueWaitTime.observe(waitTimeMs);
  }

  /**
   * Get the Prometheus registry
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Get metrics in Prometheus text format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get content type for Prometheus metrics
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.registry.resetMetrics();
  }

  /**
   * Clear all metrics and remove them from registry
   */
  clear(): void {
    this.registry.clear();
  }
}

/**
 * Singleton instance for global access
 */
let globalMetrics: SchedulerMetrics | null = null;

/**
 * Get or create the global metrics instance
 */
export function getMetrics(config?: MetricsConfig): SchedulerMetrics {
  if (!globalMetrics) {
    globalMetrics = new SchedulerMetrics(config);
  }
  return globalMetrics;
}

/**
 * Reset the global metrics instance (useful for testing)
 */
export function resetGlobalMetrics(): void {
  if (globalMetrics) {
    globalMetrics.clear();
    globalMetrics = null;
  }
}
