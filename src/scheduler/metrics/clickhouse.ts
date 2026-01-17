/**
 * ClickHouse Writer for Scheduler Decision Logging
 *
 * Provides persistent storage for scheduling decisions in ClickHouse
 * for analysis, debugging, and decision replay.
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';

/**
 * ClickHouse configuration options
 */
export interface ClickHouseConfig {
  /** ClickHouse server URL */
  url?: string;
  /** Database name */
  database?: string;
  /** Username for authentication */
  username?: string;
  /** Password for authentication */
  password?: string;
  /** Connection timeout in milliseconds */
  requestTimeout?: number;
  /** Table name for scheduler decisions */
  tableName?: string;
  /** Batch size for insert operations */
  batchSize?: number;
  /** Flush interval in milliseconds */
  flushIntervalMs?: number;
}

/**
 * Default ClickHouse configuration
 */
export const DEFAULT_CLICKHOUSE_CONFIG: Required<ClickHouseConfig> = {
  url: 'http://localhost:8123',
  database: 'nexus',
  username: 'default',
  password: '',
  requestTimeout: 30000,
  tableName: 'scheduler_decisions',
  batchSize: 1000,
  flushIntervalMs: 5000,
};

/**
 * Scheduler decision record for ClickHouse
 */
export interface SchedulerDecisionRecord {
  /** Timestamp of the decision */
  timestamp: Date;
  /** Task identifier */
  taskId: string;
  /** Type of task */
  taskType: string;
  /** Selected worker identifier */
  workerId: string;
  /** Predicted task duration in milliseconds */
  predictedDurationMs: number;
  /** Predicted wait time in milliseconds */
  predictedWaitMs: number;
  /** Scheduling score (higher is better) */
  score: number;
  /** Human-readable reasoning for the decision */
  reasoning: string;
  /** Whether fallback scheduler was used */
  fallbackUsed: boolean;
}

/**
 * Raw row type from ClickHouse queries
 */
interface ClickHouseDecisionRow {
  timestamp: string;
  task_id: string;
  task_type: string;
  worker_id: string;
  predicted_duration_ms: number;
  predicted_wait_ms: number;
  score: number;
  reasoning: string;
  fallback_used: number;
}

/**
 * Raw row type for fallback stats query
 */
interface ClickHouseFallbackStatsRow {
  total: string;
  fallback_count: string;
}

/**
 * Convert a ClickHouse row to a SchedulerDecisionRecord
 */
function rowToRecord(row: ClickHouseDecisionRow): SchedulerDecisionRecord {
  return {
    timestamp: new Date(row.timestamp),
    taskId: row.task_id,
    taskType: row.task_type,
    workerId: row.worker_id,
    predictedDurationMs: row.predicted_duration_ms,
    predictedWaitMs: row.predicted_wait_ms,
    score: row.score,
    reasoning: row.reasoning,
    fallbackUsed: row.fallback_used === 1,
  };
}

/**
 * ClickHouse writer for scheduler decisions
 */
export class ClickHouseWriter {
  private client: ClickHouseClient | null = null;
  private config: Required<ClickHouseConfig>;
  private buffer: SchedulerDecisionRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private connected: boolean = false;

  constructor(config: ClickHouseConfig = {}) {
    this.config = { ...DEFAULT_CLICKHOUSE_CONFIG, ...config };
  }

  /**
   * Connect to ClickHouse and initialize schema
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.client = createClient({
      url: this.config.url,
      database: this.config.database,
      username: this.config.username,
      password: this.config.password,
      request_timeout: this.config.requestTimeout,
    });

    // Create table if not exists
    await this.createTable();

    // Start periodic flush
    this.startFlushTimer();

    this.connected = true;
  }

  /**
   * Disconnect from ClickHouse
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    // Stop flush timer
    this.stopFlushTimer();

    // Flush remaining records
    await this.flush();

    // Close connection
    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    this.connected = false;
  }

  /**
   * Create the scheduler_decisions table if it doesn't exist
   */
  private async createTable(): Promise<void> {
    if (!this.client) {
      throw new Error('ClickHouse client not initialized');
    }

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS ${this.config.tableName} (
        timestamp DateTime64(3),
        task_id String,
        task_type String,
        worker_id String,
        predicted_duration_ms UInt32,
        predicted_wait_ms UInt32,
        score Float32,
        reasoning String,
        fallback_used UInt8
      ) ENGINE = MergeTree()
      ORDER BY (timestamp, task_id)
    `;

    await this.client.command({ query: createTableQuery });
  }

  /**
   * Write a decision record (buffered)
   */
  write(record: SchedulerDecisionRecord): void {
    this.buffer.push(record);

    if (this.buffer.length >= this.config.batchSize) {
      // Flush synchronously triggered, but actual flush is async
      this.flush().catch((err) => {
        console.error('Failed to flush ClickHouse buffer:', err);
      });
    }
  }

  /**
   * Flush buffered records to ClickHouse
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.client) {
      return;
    }

    const records = this.buffer.splice(0, this.buffer.length);

    try {
      await this.client.insert({
        table: this.config.tableName,
        values: records.map((r) => ({
          timestamp: r.timestamp.toISOString(),
          task_id: r.taskId,
          task_type: r.taskType,
          worker_id: r.workerId,
          predicted_duration_ms: r.predictedDurationMs,
          predicted_wait_ms: r.predictedWaitMs,
          score: r.score,
          reasoning: r.reasoning,
          fallback_used: r.fallbackUsed ? 1 : 0,
        })),
        format: 'JSONEachRow',
      });
    } catch (err) {
      // Re-add records to buffer on failure
      this.buffer.unshift(...records);
      throw err;
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('Periodic ClickHouse flush failed:', err);
      });
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop periodic flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Query decisions for a specific task
   */
  async queryByTaskId(taskId: string): Promise<SchedulerDecisionRecord[]> {
    if (!this.client) {
      throw new Error('ClickHouse client not connected');
    }

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${this.config.tableName}
        WHERE task_id = {taskId:String}
        ORDER BY timestamp DESC
      `,
      query_params: { taskId },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseDecisionRow[]>();
    return rows.map(rowToRecord);
  }

  /**
   * Query decisions for a specific worker
   */
  async queryByWorkerId(
    workerId: string,
    limit: number = 100
  ): Promise<SchedulerDecisionRecord[]> {
    if (!this.client) {
      throw new Error('ClickHouse client not connected');
    }

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${this.config.tableName}
        WHERE worker_id = {workerId:String}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { workerId, limit },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseDecisionRow[]>();
    return rows.map(rowToRecord);
  }

  /**
   * Query decisions within a time range
   */
  async queryByTimeRange(
    startTime: Date,
    endTime: Date,
    limit: number = 1000
  ): Promise<SchedulerDecisionRecord[]> {
    if (!this.client) {
      throw new Error('ClickHouse client not connected');
    }

    const result = await this.client.query({
      query: `
        SELECT *
        FROM ${this.config.tableName}
        WHERE timestamp >= {startTime:DateTime64(3)}
          AND timestamp <= {endTime:DateTime64(3)}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        limit,
      },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseDecisionRow[]>();
    return rows.map(rowToRecord);
  }

  /**
   * Get fallback usage statistics
   */
  async getFallbackStats(
    startTime: Date,
    endTime: Date
  ): Promise<{ total: number; fallback: number; ratio: number }> {
    if (!this.client) {
      throw new Error('ClickHouse client not connected');
    }

    const result = await this.client.query({
      query: `
        SELECT
          count() as total,
          sum(fallback_used) as fallback_count
        FROM ${this.config.tableName}
        WHERE timestamp >= {startTime:DateTime64(3)}
          AND timestamp <= {endTime:DateTime64(3)}
      `,
      query_params: {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
      format: 'JSONEachRow',
    });

    const rows = await result.json<ClickHouseFallbackStatsRow[]>();

    if (rows.length === 0) {
      return { total: 0, fallback: 0, ratio: 0 };
    }

    const total = parseInt(rows[0].total, 10);
    const fallback = parseInt(rows[0].fallback_count, 10);

    return {
      total,
      fallback,
      ratio: total > 0 ? fallback / total : 0,
    };
  }

  /**
   * Check if connected to ClickHouse
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}

/**
 * Singleton instance for global access
 */
let globalWriter: ClickHouseWriter | null = null;

/**
 * Get or create the global ClickHouse writer instance
 */
export function getClickHouseWriter(
  config?: ClickHouseConfig
): ClickHouseWriter {
  if (!globalWriter) {
    globalWriter = new ClickHouseWriter(config);
  }
  return globalWriter;
}

/**
 * Reset the global ClickHouse writer instance
 */
export async function resetGlobalClickHouseWriter(): Promise<void> {
  if (globalWriter) {
    await globalWriter.disconnect();
    globalWriter = null;
  }
}
