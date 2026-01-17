/**
 * Predictor interface for ML-based task scheduling
 */

import { Task, TaskPrediction } from './types';

/**
 * Interface for task prediction implementations.
 *
 * This allows dependency injection of different prediction strategies:
 * - ML model-based prediction
 * - Rule-based prediction
 * - Historical data-based prediction
 * - Mock/test implementations
 */
export interface Predictor {
  /**
   * Predicts the optimal worker for a given task
   *
   * @param task - The task to predict a worker for
   * @returns Promise resolving to prediction or null if no prediction possible
   */
  predict(task: Task): Promise<TaskPrediction | null>;

  /**
   * Optional: Check if predictor is healthy/ready
   */
  isReady?(): Promise<boolean>;

  /**
   * Optional: Update predictor with feedback on scheduling decisions
   *
   * @param taskId - The task that was scheduled
   * @param workerId - The worker that executed the task
   * @param success - Whether the task completed successfully
   * @param actualDurationMs - Actual execution duration
   */
  feedback?(
    taskId: string,
    workerId: string,
    success: boolean,
    actualDurationMs: number
  ): Promise<void>;
}

/**
 * No-op predictor that always returns null.
 * Useful for testing or when ML predictor is not available.
 */
export class NoOpPredictor implements Predictor {
  async predict(_task: Task): Promise<TaskPrediction | null> {
    return null;
  }

  async isReady(): Promise<boolean> {
    return true;
  }
}
