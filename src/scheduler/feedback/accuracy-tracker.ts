/**
 * Accuracy Tracker - Rolling window accuracy statistics
 */

import { isWithinThreshold } from './drift-detector';

/**
 * Single prediction sample for tracking
 */
export interface PredictionSample {
  taskType: string;
  predicted: number;
  actual: number;
  timestamp: Date;
  withinThreshold: boolean;
}

/**
 * Accuracy statistics
 */
export interface AccuracyStats {
  total: number;
  withinThreshold: number;
  accuracy: number;
  avgDeviation: number;
  taskTypes: number;
}

/**
 * Per-task-type accuracy breakdown
 */
export interface TaskTypeAccuracy {
  taskType: string;
  total: number;
  withinThreshold: number;
  accuracy: number;
  avgDeviation: number;
}

/**
 * Configuration for accuracy tracker
 */
export interface AccuracyTrackerConfig {
  windowSize: number; // Number of samples to track
  accuracyThreshold: number; // Deviation threshold for "accurate" (default: 0.25)
}

/**
 * Default accuracy tracker configuration
 */
export const DEFAULT_ACCURACY_CONFIG: AccuracyTrackerConfig = {
  windowSize: 1000,
  accuracyThreshold: 0.25,
};

/**
 * AccuracyTracker maintains rolling statistics on prediction accuracy
 */
export class AccuracyTracker {
  private samples: PredictionSample[] = [];
  private config: AccuracyTrackerConfig;

  constructor(config: Partial<AccuracyTrackerConfig> = {}) {
    this.config = {
      ...DEFAULT_ACCURACY_CONFIG,
      ...config,
    };
  }

  /**
   * Record a prediction result
   */
  record(taskType: string, predicted: number, actual: number): void {
    const withinThreshold = isWithinThreshold(
      predicted,
      actual,
      this.config.accuracyThreshold
    );

    const sample: PredictionSample = {
      taskType,
      predicted,
      actual,
      timestamp: new Date(),
      withinThreshold,
    };

    this.samples.push(sample);

    // Maintain window size
    if (this.samples.length > this.config.windowSize) {
      this.samples.shift();
    }
  }

  /**
   * Get overall accuracy statistics
   */
  getStats(): AccuracyStats {
    if (this.samples.length === 0) {
      return {
        total: 0,
        withinThreshold: 0,
        accuracy: 0,
        avgDeviation: 0,
        taskTypes: 0,
      };
    }

    const withinThreshold = this.samples.filter((s) => s.withinThreshold).length;
    const taskTypes = new Set(this.samples.map((s) => s.taskType)).size;

    const totalDeviation = this.samples.reduce((sum, s) => {
      return sum + Math.abs(s.actual - s.predicted) / Math.max(s.predicted, 1);
    }, 0);

    return {
      total: this.samples.length,
      withinThreshold,
      accuracy: withinThreshold / this.samples.length,
      avgDeviation: totalDeviation / this.samples.length,
      taskTypes,
    };
  }

  /**
   * Get accuracy breakdown by task type
   */
  getByTaskType(): TaskTypeAccuracy[] {
    const byType = new Map<string, PredictionSample[]>();

    for (const sample of this.samples) {
      const existing = byType.get(sample.taskType) || [];
      existing.push(sample);
      byType.set(sample.taskType, existing);
    }

    const results: TaskTypeAccuracy[] = [];

    for (const [taskType, samples] of byType) {
      const withinThreshold = samples.filter((s) => s.withinThreshold).length;
      const totalDeviation = samples.reduce((sum, s) => {
        return sum + Math.abs(s.actual - s.predicted) / Math.max(s.predicted, 1);
      }, 0);

      results.push({
        taskType,
        total: samples.length,
        withinThreshold,
        accuracy: withinThreshold / samples.length,
        avgDeviation: totalDeviation / samples.length,
      });
    }

    return results.sort((a, b) => b.total - a.total);
  }

  /**
   * Get recent samples
   */
  getRecentSamples(count: number = 10): PredictionSample[] {
    return this.samples.slice(-count);
  }

  /**
   * Get current window size
   */
  getSampleCount(): number {
    return this.samples.length;
  }

  /**
   * Clear all samples
   */
  clear(): void {
    this.samples = [];
  }

  /**
   * Check if accuracy is below target
   */
  isAccuracyBelowTarget(target: number = 0.8): boolean {
    const stats = this.getStats();
    return stats.total > 0 && stats.accuracy < target;
  }
}
