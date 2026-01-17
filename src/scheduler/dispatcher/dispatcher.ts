/**
 * Task Dispatcher - Routes tasks to workers via Redis
 */

import Redis from 'ioredis';
import {
  Task,
  SchedulingDecision,
  DispatchResult,
  CircuitBreakerState,
  SchedulerConfig,
  DEFAULT_SCHEDULER_CONFIG,
} from '../interfaces/types';
import { Predictor } from '../interfaces/predictor';
import { WorkerRegistry } from '../registry/worker-registry';
import { RoundRobinScheduler } from '../fallback/round-robin';

/**
 * Dispatcher consumes tasks from Redis Streams and dispatches them to workers.
 * Includes circuit breaker for fallback to round-robin scheduling.
 */
export class Dispatcher {
  private redis: Redis | null = null;
  private predictor: Predictor;
  private registry: WorkerRegistry;
  private fallbackScheduler: RoundRobinScheduler;
  private config: SchedulerConfig;
  private circuitBreaker: CircuitBreakerState;
  private running: boolean = false;
  private consumerName: string;

  // Stream names
  private readonly TASK_STREAM = 'nexus:tasks:pending';
  private readonly DISPATCH_CHANNEL_PREFIX = 'nexus:worker:';

  constructor(
    predictor: Predictor,
    registry: WorkerRegistry,
    config: Partial<SchedulerConfig> & { redisUrl: string }
  ) {
    this.predictor = predictor;
    this.registry = registry;
    this.config = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...config,
    } as SchedulerConfig;

    this.fallbackScheduler = new RoundRobinScheduler(registry);
    this.circuitBreaker = {
      failures: 0,
      lastFailure: null,
      isOpen: false,
    };
    this.consumerName = `dispatcher-${Date.now()}`;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    this.redis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
    });

    await this.redis.ping();
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    this.running = false;
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  /**
   * Start consuming tasks from the stream
   */
  async start(): Promise<void> {
    if (!this.redis) {
      throw new Error('Not connected to Redis. Call connect() first.');
    }

    this.running = true;

    // Create consumer group if it doesn't exist
    try {
      await this.redis.xgroup(
        'CREATE',
        this.TASK_STREAM,
        'scheduler-group',
        '0',
        'MKSTREAM'
      );
    } catch (err) {
      // Group already exists - this is fine
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }

    // Start consuming
    this.consumeLoop();
  }

  /**
   * Stop consuming tasks
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Main consumption loop
   */
  private async consumeLoop(): Promise<void> {
    while (this.running && this.redis) {
      try {
        const messages = await this.redis.xreadgroup(
          'GROUP',
          'scheduler-group',
          this.consumerName,
          'COUNT',
          10,
          'BLOCK',
          1000,
          'STREAMS',
          this.TASK_STREAM,
          '>'
        );

        if (!messages) {
          continue;
        }

        for (const streamData of messages as Array<[string, Array<[string, string[]]>]>) {
          const entries = streamData[1];
          for (const entry of entries) {
            const messageId = entry[0];
            const fields = entry[1];
            const task = this.parseTask(messageId, fields);
            if (task) {
              await this.dispatchTask(task, messageId);
            }
          }
        }
      } catch (err) {
        console.error('Error in consume loop:', err);
        await this.sleep(1000);
      }
    }
  }

  /**
   * Parse task from Redis stream message
   */
  private parseTask(messageId: string, fields: string[]): Task | null {
    try {
      const data: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1];
      }

      return {
        id: data['id'] || messageId,
        type: data['type'] || 'unknown',
        payload: JSON.parse(data['payload'] || '{}'),
        priority: parseInt(data['priority'] || '0', 10),
        createdAt: new Date(data['createdAt'] || Date.now()),
        metadata: data['metadata'] ? JSON.parse(data['metadata']) : undefined,
      };
    } catch (err) {
      console.error('Failed to parse task:', err);
      return null;
    }
  }

  /**
   * Dispatch a single task to a worker
   */
  async dispatchTask(task: Task, messageId?: string): Promise<DispatchResult> {
    let decision: SchedulingDecision | null = null;

    // Try prediction if circuit breaker is closed
    if (!this.circuitBreaker.isOpen) {
      try {
        const prediction = await this.predictor.predict(task);

        if (prediction) {
          // Verify worker is available
          const worker = this.registry.get(prediction.recommendedWorkerId);
          if (worker && worker.status !== 'offline' && worker.status !== 'draining') {
            decision = {
              taskId: task.id,
              workerId: prediction.recommendedWorkerId,
              timestamp: new Date(),
              usedFallback: false,
              prediction,
              reason: 'prediction',
            };

            // Reset circuit breaker on success
            this.resetCircuitBreaker();
          }
        }
      } catch (err) {
        console.error('Prediction failed:', err);
        this.recordFailure();
      }
    }

    // Fallback to round-robin if no prediction
    if (!decision) {
      const reason = this.circuitBreaker.isOpen
        ? 'fallback_circuit_breaker'
        : 'fallback_round_robin';

      decision = this.fallbackScheduler.schedule(task, reason);
    }

    // No workers available
    if (!decision) {
      return {
        success: false,
        decision: {
          taskId: task.id,
          workerId: '',
          timestamp: new Date(),
          usedFallback: true,
          reason: 'fallback_round_robin',
        },
        error: 'No workers available',
      };
    }

    // Dispatch to worker via Redis publish
    try {
      if (this.redis) {
        const channel = `${this.DISPATCH_CHANNEL_PREFIX}${decision.workerId}`;
        await this.redis.publish(
          channel,
          JSON.stringify({
            taskId: task.id,
            task,
            assignedAt: decision.timestamp.toISOString(),
          })
        );

        // Acknowledge the message
        if (messageId) {
          await this.redis.xack(this.TASK_STREAM, 'scheduler-group', messageId);
        }
      }

      return {
        success: true,
        decision,
      };
    } catch (err) {
      return {
        success: false,
        decision,
        error: err instanceof Error ? err.message : 'Dispatch failed',
      };
    }
  }

  /**
   * Record a prediction failure
   */
  private recordFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = new Date();

    if (this.circuitBreaker.failures >= this.config.fallbackThreshold) {
      this.circuitBreaker.isOpen = true;
      console.warn(
        `Circuit breaker opened after ${this.circuitBreaker.failures} failures`
      );
    }
  }

  /**
   * Reset circuit breaker on successful prediction
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.lastFailure = null;
    this.circuitBreaker.isOpen = false;
  }

  /**
   * Get current circuit breaker state
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return { ...this.circuitBreaker };
  }

  /**
   * Check if dispatcher is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Helper sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
