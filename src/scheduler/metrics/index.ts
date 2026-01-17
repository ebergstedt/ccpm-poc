/**
 * Metrics and Observability Module
 *
 * Provides comprehensive observability for the Nexus Scheduler including:
 * - Prometheus metrics for monitoring and alerting
 * - ClickHouse persistence for decision audit logging
 * - Structured JSON logging with correlation IDs
 */

// Prometheus metrics
export {
  SchedulerMetrics,
  MetricsConfig,
  DEFAULT_METRICS_CONFIG,
  DecisionStatus,
  WorkerHealthStatus,
  getMetrics,
  resetGlobalMetrics,
} from './prometheus';

// ClickHouse writer
export {
  ClickHouseWriter,
  ClickHouseConfig,
  DEFAULT_CLICKHOUSE_CONFIG,
  SchedulerDecisionRecord,
  getClickHouseWriter,
  resetGlobalClickHouseWriter,
} from './clickhouse';

// Decision logger
export {
  DecisionLogger,
  DecisionLoggerConfig,
  DEFAULT_DECISION_LOGGER_CONFIG,
  LogLevel,
  LogEntry,
  DecisionContext,
  getDecisionLogger,
  resetGlobalDecisionLogger,
  createRequestLogger,
} from './decision-logger';

/**
 * Initialize all observability components
 */
export interface ObservabilityConfig {
  /** Prometheus metrics configuration */
  metrics?: import('./prometheus').MetricsConfig;
  /** ClickHouse configuration */
  clickhouse?: import('./clickhouse').ClickHouseConfig;
  /** Decision logger configuration */
  logger?: import('./decision-logger').DecisionLoggerConfig;
}

/**
 * Observability facade for easy initialization
 */
export class Observability {
  public readonly metrics: import('./prometheus').SchedulerMetrics;
  public readonly clickhouse: import('./clickhouse').ClickHouseWriter;
  public readonly logger: import('./decision-logger').DecisionLogger;

  constructor(config: ObservabilityConfig = {}) {
    // Import modules dynamically to avoid circular dependencies
    const { SchedulerMetrics } = require('./prometheus');
    const { ClickHouseWriter } = require('./clickhouse');
    const { DecisionLogger } = require('./decision-logger');

    this.metrics = new SchedulerMetrics(config.metrics);
    this.clickhouse = new ClickHouseWriter(config.clickhouse);
    this.logger = new DecisionLogger(
      config.logger,
      this.metrics,
      this.clickhouse
    );
  }

  /**
   * Connect to external services (ClickHouse)
   */
  async connect(): Promise<void> {
    await this.clickhouse.connect();
  }

  /**
   * Disconnect from external services
   */
  async disconnect(): Promise<void> {
    await this.clickhouse.disconnect();
  }

  /**
   * Get Prometheus metrics in text format
   */
  async getPrometheusMetrics(): Promise<string> {
    return this.metrics.getMetrics();
  }

  /**
   * Get content type for Prometheus endpoint
   */
  getPrometheusContentType(): string {
    return this.metrics.getContentType();
  }

  /**
   * Flush pending ClickHouse records
   */
  async flushClickHouse(): Promise<void> {
    await this.clickhouse.flush();
  }
}

/**
 * Singleton observability instance
 */
let globalObservability: Observability | null = null;

/**
 * Get or create the global observability instance
 */
export function getObservability(config?: ObservabilityConfig): Observability {
  if (!globalObservability) {
    globalObservability = new Observability(config);
  }
  return globalObservability;
}

/**
 * Reset the global observability instance
 */
export async function resetGlobalObservability(): Promise<void> {
  if (globalObservability) {
    await globalObservability.disconnect();
    globalObservability = null;
  }
}
