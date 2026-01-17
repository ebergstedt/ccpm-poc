/**
 * Redis persistence for prediction state
 */

import { createClient, RedisClientType } from 'redis';
import { EMAState } from './ema';

/**
 * Persistence configuration
 */
export interface PersistenceConfig {
  redisUrl: string;
  redisKey: string;
  snapshotInterval: number; // Save after every N updates
}

/**
 * Default persistence configuration
 */
export const DEFAULT_PERSISTENCE_CONFIG: Omit<PersistenceConfig, 'redisUrl'> = {
  redisKey: 'scheduler:predictions',
  snapshotInterval: 100,
};

/**
 * Serialized prediction state for Redis storage
 */
export interface SerializedState {
  predictions: Record<string, {
    ema: number;
    sampleCount: number;
    lastUpdated: string;
  }>;
  savedAt: string;
  version: number;
}

/**
 * PredictionPersistence handles saving/loading prediction state to Redis
 */
export class PredictionPersistence {
  private client: RedisClientType | null = null;
  private config: PersistenceConfig;
  private updatesSinceSnapshot: number = 0;
  private connected: boolean = false;

  constructor(config: Partial<PersistenceConfig> & { redisUrl: string }) {
    this.config = {
      ...DEFAULT_PERSISTENCE_CONFIG,
      ...config,
    };
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.client = createClient({ url: this.config.redisUrl });

    this.client.on('error', (err) => {
      console.error('Redis persistence error:', err);
    });

    await this.client.connect();
    this.connected = true;
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.disconnect();
      this.connected = false;
      this.client = null;
    }
  }

  /**
   * Check if connected to Redis
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Save predictions to Redis
   */
  async save(predictions: Map<string, EMAState>): Promise<void> {
    if (!this.client || !this.connected) {
      console.warn('Cannot save predictions: not connected to Redis');
      return;
    }

    const serialized: SerializedState = {
      predictions: {},
      savedAt: new Date().toISOString(),
      version: 1,
    };

    for (const [taskType, state] of predictions.entries()) {
      serialized.predictions[taskType] = {
        ema: state.ema,
        sampleCount: state.sampleCount,
        lastUpdated: state.lastUpdated.toISOString(),
      };
    }

    await this.client.set(this.config.redisKey, JSON.stringify(serialized));
    this.updatesSinceSnapshot = 0;
  }

  /**
   * Load predictions from Redis
   */
  async load(): Promise<Map<string, EMAState> | null> {
    if (!this.client || !this.connected) {
      console.warn('Cannot load predictions: not connected to Redis');
      return null;
    }

    const data = await this.client.get(this.config.redisKey);
    if (!data) {
      return null;
    }

    try {
      const serialized: SerializedState = JSON.parse(data);
      const predictions = new Map<string, EMAState>();

      for (const [taskType, state] of Object.entries(serialized.predictions)) {
        predictions.set(taskType, {
          taskType,
          ema: state.ema,
          sampleCount: state.sampleCount,
          lastUpdated: new Date(state.lastUpdated),
        });
      }

      return predictions;
    } catch (err) {
      console.error('Failed to parse prediction state:', err);
      return null;
    }
  }

  /**
   * Track update and snapshot if needed
   */
  async trackUpdate(predictions: Map<string, EMAState>): Promise<void> {
    this.updatesSinceSnapshot++;

    if (this.updatesSinceSnapshot >= this.config.snapshotInterval) {
      await this.save(predictions);
    }
  }

  /**
   * Get updates since last snapshot
   */
  getUpdatesSinceSnapshot(): number {
    return this.updatesSinceSnapshot;
  }
}
