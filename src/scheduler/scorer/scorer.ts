/**
 * Multi-Objective Scorer - Selects optimal worker for task assignment
 */

import { Task, WorkerState, TaskPrediction } from '../interfaces/types';
import {
  calculateWaitScore,
  calculateLoadScore,
  calculatePriorityScore,
  estimateWaitTime,
  isWorkerEligible,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_MAX_PRIORITY,
} from './objectives';

/**
 * Scoring weights configuration
 */
export interface ScoringWeights {
  wait: number;     // Weight for wait time objective
  load: number;     // Weight for load balancing objective
  priority: number; // Weight for priority objective
}

/**
 * Default scoring weights
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  wait: 0.4,
  load: 0.4,
  priority: 0.2,
};

/**
 * Scorer configuration
 */
export interface ScorerConfig {
  weights: ScoringWeights;
  maxWaitMs: number;
  maxPriority: number;
}

/**
 * Partial scorer configuration for constructor
 */
export interface PartialScorerConfig {
  weights?: Partial<ScoringWeights>;
  maxWaitMs?: number;
  maxPriority?: number;
}

/**
 * Default scorer configuration
 */
export const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  weights: DEFAULT_SCORING_WEIGHTS,
  maxWaitMs: DEFAULT_MAX_WAIT_MS,
  maxPriority: DEFAULT_MAX_PRIORITY,
};

/**
 * Worker score result
 */
export interface WorkerScore {
  workerId: string;
  score: number;
  breakdown: {
    waitScore: number;
    loadScore: number;
    priorityScore: number;
  };
}

/**
 * Final scoring result
 */
export interface ScoringResult {
  workerId: string;
  score: number;
  reasoning: string;
  alternatives: WorkerScore[];
}

/**
 * MultiObjectiveScorer evaluates workers for task assignment
 */
export class MultiObjectiveScorer {
  private config: ScorerConfig;

  constructor(config: PartialScorerConfig = {}) {
    this.config = {
      ...DEFAULT_SCORER_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_SCORING_WEIGHTS,
        ...config.weights,
      },
    };
  }

  /**
   * Score all eligible workers and select the best one
   *
   * @param task - Task to be scheduled
   * @param workers - Available workers
   * @param prediction - Task duration prediction
   * @returns Scoring result or null if no eligible workers
   */
  score(
    task: Task,
    workers: WorkerState[],
    prediction: TaskPrediction | null
  ): ScoringResult | null {
    // Get eligible workers
    const requiredCapabilities = task.metadata?.requiredCapabilities;
    const eligibleWorkers = workers.filter((w) =>
      isWorkerEligible(w, requiredCapabilities)
    );

    if (eligibleWorkers.length === 0) {
      return null;
    }

    // Score all eligible workers
    const scores = eligibleWorkers.map((worker) =>
      this.scoreWorker(task, worker, prediction)
    );

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Select best worker
    const best = scores[0];
    const alternatives = scores.slice(1);

    // Generate reasoning
    const reasoning = this.generateReasoning(best, task);

    return {
      workerId: best.workerId,
      score: best.score,
      reasoning,
      alternatives,
    };
  }

  /**
   * Score a single worker for a task
   */
  private scoreWorker(
    task: Task,
    worker: WorkerState,
    prediction: TaskPrediction | null
  ): WorkerScore {
    const { weights, maxWaitMs, maxPriority } = this.config;

    // Calculate individual scores
    const estimatedWaitMs = estimateWaitTime(worker, prediction);
    const waitScore = calculateWaitScore(estimatedWaitMs, maxWaitMs);
    const loadScore = calculateLoadScore(worker.currentLoad);
    const priorityScore = calculatePriorityScore(task.priority, maxPriority);

    // Calculate weighted sum
    const score =
      weights.wait * waitScore +
      weights.load * loadScore +
      weights.priority * priorityScore;

    return {
      workerId: worker.id,
      score,
      breakdown: {
        waitScore,
        loadScore,
        priorityScore,
      },
    };
  }

  /**
   * Generate human-readable reasoning for the decision
   */
  private generateReasoning(best: WorkerScore, task: Task): string {
    const { waitScore, loadScore, priorityScore } = best.breakdown;
    return `Selected ${best.workerId}: score=${best.score.toFixed(2)} ` +
      `(wait=${waitScore.toFixed(2)}, load=${loadScore.toFixed(2)}, priority=${priorityScore.toFixed(2)}) ` +
      `for task ${task.id} with priority ${task.priority}`;
  }

  /**
   * Update scoring weights at runtime
   */
  updateWeights(weights: Partial<ScoringWeights>): void {
    this.config.weights = {
      ...this.config.weights,
      ...weights,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): ScorerConfig {
    return { ...this.config };
  }

  /**
   * Validate that weights sum to approximately 1.0
   */
  validateWeights(): boolean {
    const { wait, load, priority } = this.config.weights;
    const sum = wait + load + priority;
    return Math.abs(sum - 1.0) < 0.001;
  }
}
