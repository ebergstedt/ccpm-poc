/**
 * Nexus Scheduler Service Entry Point
 */

import { SchedulerConfig, DEFAULT_SCHEDULER_CONFIG } from './interfaces/types';
import { Predictor, NoOpPredictor } from './interfaces/predictor';
import { WorkerRegistry } from './registry/worker-registry';
import { Dispatcher } from './dispatcher/dispatcher';

// Re-export public types and classes
export * from './interfaces/types';
export * from './interfaces/predictor';
export { WorkerRegistry } from './registry/worker-registry';
export { Dispatcher } from './dispatcher/dispatcher';
export { RoundRobinScheduler } from './fallback/round-robin';

/**
 * Scheduler Service - Main orchestrator for the Nexus Scheduler
 */
export class SchedulerService {
  private config: SchedulerConfig;
  private predictor: Predictor;
  private registry: WorkerRegistry;
  private dispatcher: Dispatcher;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  constructor(
    config: Partial<SchedulerConfig> & { redisUrl: string },
    predictor?: Predictor
  ) {
    this.config = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...config,
    } as SchedulerConfig;

    this.predictor = predictor || new NoOpPredictor();
    this.registry = new WorkerRegistry(this.config.heartbeatTimeoutMs);
    this.dispatcher = new Dispatcher(this.predictor, this.registry, this.config);
  }

  /**
   * Start the scheduler service
   */
  async start(): Promise<void> {
    console.log('Starting Nexus Scheduler...');

    try {
      // Connect to Redis
      await this.dispatcher.connect();
      console.log('Connected to Redis');

      // Start dispatcher
      await this.dispatcher.start();
      console.log('Dispatcher started');

      // Start heartbeat pruning
      this.startHeartbeatCheck();

      this.running = true;
      console.log('Nexus Scheduler is running');
    } catch (err) {
      console.error('Failed to start scheduler:', err);
      await this.stop();
      throw err;
    }
  }

  /**
   * Stop the scheduler service gracefully
   */
  async stop(): Promise<void> {
    console.log('Stopping Nexus Scheduler...');

    this.running = false;

    // Stop heartbeat check
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop dispatcher
    this.dispatcher.stop();

    // Disconnect from Redis
    await this.dispatcher.disconnect();

    console.log('Nexus Scheduler stopped');
  }

  /**
   * Start periodic heartbeat checking
   */
  private startHeartbeatCheck(): void {
    // Check for stale workers every 10 seconds
    this.heartbeatInterval = setInterval(() => {
      const pruned = this.registry.pruneStale();
      if (pruned.length > 0) {
        console.log(`Pruned ${pruned.length} stale workers: ${pruned.join(', ')}`);
      }
    }, 10000);
  }

  /**
   * Get the worker registry
   */
  getRegistry(): WorkerRegistry {
    return this.registry;
  }

  /**
   * Get the dispatcher
   */
  getDispatcher(): Dispatcher {
    return this.dispatcher;
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get service configuration
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }
}

/**
 * Create and start the scheduler from environment variables
 */
async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] || 'redis://localhost:6379';
  const fallbackThreshold = parseInt(process.env['FALLBACK_THRESHOLD'] || '3', 10);
  const heartbeatTimeoutMs = parseInt(
    process.env['HEARTBEAT_TIMEOUT_MS'] || '30000',
    10
  );

  const scheduler = new SchedulerService({
    redisUrl,
    fallbackThreshold,
    heartbeatTimeoutMs,
  });

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    await scheduler.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    shutdown('unhandledRejection');
  });

  // Start the scheduler
  await scheduler.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
