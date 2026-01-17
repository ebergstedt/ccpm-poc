/**
 * Heuristic Predictor - EMA-based task duration prediction
 */

import { Predictor } from '../interfaces/predictor';
import { Task, TaskPrediction } from '../interfaces/types';
import { EMAState, updateEMAState, initializeEMA, calculateConfidence } from './ema';
import { PredictionPersistence } from './persistence';

/**
 * Predictor configuration
 */
export interface HeuristicPredictorConfig {
  alpha: number; // EMA smoothing factor (default: 0.3)
  defaultDurationMs: number; // Fallback for unknown task types (default: 5000)
  confidenceThreshold: number; // Samples for full confidence (default: 100)
  redisUrl: string;
  redisKey?: string;
  snapshotInterval?: number;
}

/**
 * Default predictor configuration
 */
export const DEFAULT_PREDICTOR_CONFIG: Omit<HeuristicPredictorConfig, 'redisUrl'> = {
  alpha: 0.3,
  defaultDurationMs: 5000,
  confidenceThreshold: 100,
};

/**
 * HeuristicPredictor implements task duration prediction using
 * exponential moving averages per task type.
 */
export class HeuristicPredictor implements Predictor {
  private predictions: Map<string, EMAState> = new Map();
  private config: HeuristicPredictorConfig;
  private persistence: PredictionPersistence;
  private ready: boolean = false;

  constructor(config: Partial<HeuristicPredictorConfig> & { redisUrl: string }) {
    this.config = {
      ...DEFAULT_PREDICTOR_CONFIG,
      ...config,
    };

    this.persistence = new PredictionPersistence({
      redisUrl: this.config.redisUrl,
      redisKey: this.config.redisKey,
      snapshotInterval: this.config.snapshotInterval,
    });
  }

  /**
   * Initialize the predictor (connect to Redis and load state)
   */
  async initialize(): Promise<void> {
    try {
      await this.persistence.connect();

      // Try to restore from Redis
      const restored = await this.persistence.load();
      if (restored) {
        this.predictions = restored;
        console.log(`Restored ${restored.size} predictions from Redis`);
      } else {
        console.log('No predictions found in Redis, starting fresh');
      }

      this.ready = true;
    } catch (err) {
      console.warn('Failed to connect to Redis for predictions:', err);
      // Continue without persistence - predictor still works
      this.ready = true;
    }
  }

  /**
   * Shutdown the predictor (save state and disconnect)
   */
  async shutdown(): Promise<void> {
    if (this.persistence.isConnected()) {
      // Final save before shutdown
      await this.persistence.save(this.predictions);
      await this.persistence.disconnect();
    }
    this.ready = false;
  }

  /**
   * Check if predictor is ready
   */
  async isReady(): Promise<boolean> {
    return this.ready;
  }

  /**
   * Predict optimal worker for a task
   *
   * Note: This predictor focuses on duration prediction.
   * Worker selection is handled by the scorer component.
   */
  async predict(task: Task): Promise<TaskPrediction | null> {
    const state = this.predictions.get(task.type);

    let estimatedDurationMs: number;
    let confidence: number;

    if (state) {
      estimatedDurationMs = state.ema;
      confidence = calculateConfidence(state.sampleCount, this.config.confidenceThreshold);
    } else {
      // Unknown task type - use default
      estimatedDurationMs = this.config.defaultDurationMs;
      confidence = 0;
    }

    // Return prediction without worker recommendation
    // (worker selection is done by scorer based on this prediction)
    return {
      taskId: task.id,
      recommendedWorkerId: '', // Will be filled by scorer
      confidence,
      estimatedDurationMs,
    };
  }

  /**
   * Update prediction with actual execution result
   */
  async feedback(
    _taskId: string,
    _workerId: string,
    _success: boolean,
    actualDurationMs: number,
    taskType?: string
  ): Promise<void> {
    if (!taskType) {
      console.warn('Feedback received without task type, ignoring');
      return;
    }

    let state = this.predictions.get(taskType);

    if (!state) {
      // First observation for this task type
      state = initializeEMA(taskType, this.config.defaultDurationMs);
    }

    // Update EMA with actual duration
    const updated = updateEMAState(state, actualDurationMs, this.config.alpha);
    this.predictions.set(taskType, updated);

    // Track update and snapshot if needed
    if (this.persistence.isConnected()) {
      await this.persistence.trackUpdate(this.predictions);
    }
  }

  /**
   * Get prediction for a specific task type
   */
  getPrediction(taskType: string): { estimatedDurationMs: number; confidence: number } {
    const state = this.predictions.get(taskType);

    if (state) {
      return {
        estimatedDurationMs: state.ema,
        confidence: calculateConfidence(state.sampleCount, this.config.confidenceThreshold),
      };
    }

    return {
      estimatedDurationMs: this.config.defaultDurationMs,
      confidence: 0,
    };
  }

  /**
   * Get all predictions
   */
  getAllPredictions(): Map<string, EMAState> {
    return new Map(this.predictions);
  }

  /**
   * Get statistics about predictions
   */
  getStats(): {
    taskTypes: number;
    avgConfidence: number;
    totalSamples: number;
  } {
    let totalConfidence = 0;
    let totalSamples = 0;

    for (const state of this.predictions.values()) {
      totalConfidence += calculateConfidence(state.sampleCount, this.config.confidenceThreshold);
      totalSamples += state.sampleCount;
    }

    const taskTypes = this.predictions.size;

    return {
      taskTypes,
      avgConfidence: taskTypes > 0 ? totalConfidence / taskTypes : 0,
      totalSamples,
    };
  }

  /**
   * Reset predictions for a specific task type
   */
  resetPrediction(taskType: string): boolean {
    return this.predictions.delete(taskType);
  }

  /**
   * Reset all predictions
   */
  resetAll(): void {
    this.predictions.clear();
  }
}
