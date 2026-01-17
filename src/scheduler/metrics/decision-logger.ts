/**
 * Decision Logger for Scheduler Observability
 *
 * Provides structured JSON logging with correlation IDs for tracing
 * scheduling decisions across the system.
 */

import { v4 as uuidv4 } from 'uuid';
import { SchedulingDecision, Task, WorkerState } from '../interfaces/types';
import { SchedulerMetrics, DecisionStatus } from './prometheus';
import { ClickHouseWriter, SchedulerDecisionRecord } from './clickhouse';

/**
 * Log levels for structured logging
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Correlation ID for tracing */
  correlationId: string;
  /** Event type */
  event: string;
  /** Additional data fields */
  [key: string]: unknown;
}

/**
 * Decision logger configuration
 */
export interface DecisionLoggerConfig {
  /** Minimum log level to output */
  minLevel?: LogLevel;
  /** Custom log output function */
  output?: (entry: LogEntry) => void;
  /** Enable console output */
  enableConsole?: boolean;
  /** Enable Prometheus metrics */
  enableMetrics?: boolean;
  /** Enable ClickHouse persistence */
  enableClickHouse?: boolean;
}

/**
 * Default decision logger configuration
 */
export const DEFAULT_DECISION_LOGGER_CONFIG: Required<DecisionLoggerConfig> = {
  minLevel: 'info',
  output: (entry) => console.log(JSON.stringify(entry)),
  enableConsole: true,
  enableMetrics: true,
  enableClickHouse: true,
};

/**
 * Log level priority mapping
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Decision context for logging
 */
export interface DecisionContext {
  /** Task being scheduled */
  task: Task;
  /** Selected worker (if any) */
  worker?: WorkerState;
  /** Scheduling decision */
  decision?: SchedulingDecision;
  /** Decision latency in milliseconds */
  latencyMs?: number;
  /** Error information */
  error?: Error | string;
  /** Additional context fields */
  extra?: Record<string, unknown>;
}

/**
 * Decision Logger for scheduler observability
 */
export class DecisionLogger {
  private config: Required<DecisionLoggerConfig>;
  private metrics: SchedulerMetrics | null = null;
  private clickhouse: ClickHouseWriter | null = null;
  private correlationId: string;

  constructor(
    config: DecisionLoggerConfig = {},
    metrics?: SchedulerMetrics,
    clickhouse?: ClickHouseWriter
  ) {
    this.config = { ...DEFAULT_DECISION_LOGGER_CONFIG, ...config };
    this.metrics = metrics || null;
    this.clickhouse = clickhouse || null;
    this.correlationId = uuidv4();
  }

  /**
   * Set external dependencies after construction
   */
  setDependencies(
    metrics?: SchedulerMetrics,
    clickhouse?: ClickHouseWriter
  ): void {
    if (metrics) this.metrics = metrics;
    if (clickhouse) this.clickhouse = clickhouse;
  }

  /**
   * Create a child logger with a new correlation ID
   */
  child(correlationId?: string): DecisionLogger {
    const child = new DecisionLogger(
      this.config,
      this.metrics || undefined,
      this.clickhouse || undefined
    );
    child.correlationId = correlationId || uuidv4();
    return child;
  }

  /**
   * Create a child logger for a specific task
   */
  forTask(taskId: string): DecisionLogger {
    return this.child(`task-${taskId}`);
  }

  /**
   * Get the current correlation ID
   */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Log a scheduling decision start
   */
  logDecisionStart(context: DecisionContext): void {
    this.log('info', 'scheduling_decision_start', {
      taskId: context.task.id,
      taskType: context.task.type,
      priority: context.task.priority,
      ...context.extra,
    });
  }

  /**
   * Log a successful scheduling decision
   */
  logDecisionSuccess(context: DecisionContext): void {
    const { task, worker, decision, latencyMs } = context;

    // Log structured entry
    this.log('info', 'scheduling_decision_success', {
      taskId: task.id,
      taskType: task.type,
      workerId: decision?.workerId || worker?.id,
      score: decision?.prediction?.confidence,
      latencyMs,
      usedFallback: decision?.usedFallback,
      reason: decision?.reason,
      ...context.extra,
    });

    // Update Prometheus metrics
    if (this.config.enableMetrics && this.metrics && latencyMs !== undefined) {
      const status: DecisionStatus = decision?.usedFallback
        ? 'fallback'
        : 'success';
      this.metrics.recordDecision(status, latencyMs);

      if (worker) {
        this.metrics.recordDispatch(task.type, worker.id);
      }
    }

    // Write to ClickHouse
    if (this.config.enableClickHouse && this.clickhouse && decision) {
      const record: SchedulerDecisionRecord = {
        timestamp: decision.timestamp,
        taskId: task.id,
        taskType: task.type,
        workerId: decision.workerId,
        predictedDurationMs: decision.prediction?.estimatedDurationMs || 0,
        predictedWaitMs: 0,
        score: decision.prediction?.confidence || 0,
        reasoning: decision.reason,
        fallbackUsed: decision.usedFallback,
      };
      this.clickhouse.write(record);
    }
  }

  /**
   * Log a failed scheduling decision
   */
  logDecisionError(context: DecisionContext): void {
    const { task, error, latencyMs } = context;

    const errorMessage =
      error instanceof Error ? error.message : String(error || 'Unknown error');

    this.log('error', 'scheduling_decision_error', {
      taskId: task.id,
      taskType: task.type,
      error: errorMessage,
      latencyMs,
      ...context.extra,
    });

    // Update Prometheus metrics
    if (this.config.enableMetrics && this.metrics && latencyMs !== undefined) {
      this.metrics.recordDecision('error', latencyMs);
      this.metrics.recordDispatchError(errorMessage);
    }
  }

  /**
   * Log a fallback scheduler activation
   */
  logFallbackActivation(reason: string, extra?: Record<string, unknown>): void {
    this.log('warn', 'fallback_scheduler_activated', {
      reason,
      ...extra,
    });
  }

  /**
   * Log worker health change
   */
  logWorkerHealthChange(
    workerId: string,
    previousStatus: string,
    newStatus: string,
    reason?: string
  ): void {
    this.log('info', 'worker_health_change', {
      workerId,
      previousStatus,
      newStatus,
      reason,
    });
  }

  /**
   * Log prediction accuracy feedback
   */
  logPredictionAccuracy(
    taskId: string,
    predictedMs: number,
    actualMs: number
  ): void {
    const ratio = actualMs > 0 ? predictedMs / actualMs : 0;

    this.log('debug', 'prediction_accuracy', {
      taskId,
      predictedMs,
      actualMs,
      ratio,
      accurate: ratio >= 0.8 && ratio <= 1.2,
    });

    // Update Prometheus metrics
    if (this.config.enableMetrics && this.metrics) {
      this.metrics.recordPredictionAccuracy(predictedMs, actualMs);
    }
  }

  /**
   * Log queue depth change
   */
  logQueueDepth(depth: number): void {
    this.log('debug', 'queue_depth', { depth });

    if (this.config.enableMetrics && this.metrics) {
      this.metrics.updateQueueDepth(depth);
    }
  }

  /**
   * Generic debug log
   */
  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }

  /**
   * Generic info log
   */
  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }

  /**
   * Generic warning log
   */
  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }

  /**
   * Generic error log
   */
  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    event: string,
    data?: Record<string, unknown>
  ): void {
    // Check log level
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      correlationId: this.correlationId,
      event,
      ...data,
    };

    // Output log entry
    if (this.config.enableConsole) {
      this.config.output(entry);
    }
  }
}

/**
 * Singleton instance for global access
 */
let globalLogger: DecisionLogger | null = null;

/**
 * Get or create the global decision logger instance
 */
export function getDecisionLogger(
  config?: DecisionLoggerConfig,
  metrics?: SchedulerMetrics,
  clickhouse?: ClickHouseWriter
): DecisionLogger {
  if (!globalLogger) {
    globalLogger = new DecisionLogger(config, metrics, clickhouse);
  }
  return globalLogger;
}

/**
 * Reset the global decision logger instance
 */
export function resetGlobalDecisionLogger(): void {
  globalLogger = null;
}

/**
 * Create a logger for a specific request/task
 */
export function createRequestLogger(
  taskId: string,
  baseLogger?: DecisionLogger
): DecisionLogger {
  const logger = baseLogger || getDecisionLogger();
  return logger.forTask(taskId);
}
