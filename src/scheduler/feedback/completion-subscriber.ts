/**
 * Completion Subscriber - Listens for task completion events
 */

import { EventEmitter } from 'events';
import { Predictor } from '../interfaces/predictor';
import { detectDrift, DriftConfig, DEFAULT_DRIFT_CONFIG, DriftResult } from './drift-detector';
import { AccuracyTracker, AccuracyStats } from './accuracy-tracker';

/**
 * Task completion event from workers
 */
export interface TaskCompletion {
  taskId: string;
  taskType: string;
  workerId: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  success: boolean;
  predictedDurationMs?: number;
}

/**
 * Configuration for completion subscriber
 */
export interface CompletionSubscriberConfig {
  drift: DriftConfig;
  accuracyWindowSize: number;
  accuracyThreshold: number;
}

/**
 * Default configuration
 */
export const DEFAULT_COMPLETION_CONFIG: CompletionSubscriberConfig = {
  drift: DEFAULT_DRIFT_CONFIG,
  accuracyWindowSize: 1000,
  accuracyThreshold: 0.25,
};

/**
 * Feedback event types
 */
export type FeedbackEvent =
  | { type: 'drift_detected'; taskType: string; drift: DriftResult }
  | { type: 'prediction_updated'; taskType: string; predicted: number; actual: number }
  | { type: 'accuracy_warning'; stats: AccuracyStats };

/**
 * CompletionSubscriber handles task completion feedback
 */
export class CompletionSubscriber extends EventEmitter {
  private predictor: Predictor | null = null;
  private accuracyTracker: AccuracyTracker;
  private config: CompletionSubscriberConfig;
  private isRunning: boolean = false;
  private completionCount: number = 0;

  constructor(config: Partial<CompletionSubscriberConfig> = {}) {
    super();
    this.config = {
      ...DEFAULT_COMPLETION_CONFIG,
      ...config,
    };
    this.accuracyTracker = new AccuracyTracker({
      windowSize: this.config.accuracyWindowSize,
      accuracyThreshold: this.config.accuracyThreshold,
    });
  }

  /**
   * Set the predictor to update
   */
  setPredictor(predictor: Predictor): void {
    this.predictor = predictor;
  }

  /**
   * Start listening for completions
   */
  start(): void {
    this.isRunning = true;
  }

  /**
   * Stop listening for completions
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Process a task completion event
   */
  async processCompletion(completion: TaskCompletion): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.completionCount++;

    const { taskType, durationMs: actual, predictedDurationMs: predicted } = completion;

    // Check for drift if we have a prediction
    if (predicted && predicted > 0) {
      const drift = detectDrift(predicted, actual, this.config.drift);

      if (drift.isDrift) {
        console.warn(`[Feedback] Drift detected for ${taskType}: ${drift.message}`);
        this.emit('feedback', {
          type: 'drift_detected',
          taskType,
          drift,
        } as FeedbackEvent);
      }

      // Track accuracy
      this.accuracyTracker.record(taskType, predicted, actual);
    }

    // Update predictor with actual duration
    if (this.predictor?.feedback) {
      await this.predictor.feedback(
        completion.taskId,
        completion.workerId,
        completion.success,
        actual,
        taskType
      );

      this.emit('feedback', {
        type: 'prediction_updated',
        taskType,
        predicted: predicted || 0,
        actual,
      } as FeedbackEvent);
    }

    // Check overall accuracy periodically
    if (this.completionCount % 100 === 0) {
      this.checkAccuracy();
    }
  }

  /**
   * Check and warn if accuracy is below target
   */
  private checkAccuracy(): void {
    if (this.accuracyTracker.isAccuracyBelowTarget(0.8)) {
      const stats = this.accuracyTracker.getStats();
      console.warn(`[Feedback] Accuracy below 80%: ${(stats.accuracy * 100).toFixed(1)}%`);
      this.emit('feedback', {
        type: 'accuracy_warning',
        stats,
      } as FeedbackEvent);
    }
  }

  /**
   * Get current accuracy statistics
   */
  getAccuracyStats(): AccuracyStats {
    return this.accuracyTracker.getStats();
  }

  /**
   * Get accuracy breakdown by task type
   */
  getAccuracyByTaskType() {
    return this.accuracyTracker.getByTaskType();
  }

  /**
   * Get completion count
   */
  getCompletionCount(): number {
    return this.completionCount;
  }

  /**
   * Check if running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.completionCount = 0;
    this.accuracyTracker.clear();
  }
}
