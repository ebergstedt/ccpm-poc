/**
 * Shadow Mode - Run predictive scheduling without affecting dispatch
 */

import { Task, SchedulingDecision } from '../interfaces/types';
import { Predictor } from '../interfaces/predictor';
import { MultiObjectiveScorer } from '../scorer/scorer';
import { WorkerRegistry } from '../registry/worker-registry';

/**
 * Shadow comparison result
 */
export interface ShadowResult {
  taskId: string;
  predictive: {
    workerId: string;
    score: number;
    reasoning: string;
  } | null;
  actual: {
    workerId: string;
    reason: string;
  } | null;
  match: boolean;
  improvement: number | null; // Score difference if predictive is better
  timestamp: Date;
}

/**
 * Shadow mode statistics
 */
export interface ShadowStats {
  total: number;
  matches: number;
  matchRate: number;
  improvements: number;
  avgImprovement: number;
  byTaskType: Map<string, { total: number; matches: number }>;
}

/**
 * ShadowScheduler runs predictive scheduling without dispatching
 */
export class ShadowScheduler {
  private predictor: Predictor;
  private scorer: MultiObjectiveScorer;
  private registry: WorkerRegistry;
  private results: ShadowResult[] = [];
  private maxResults: number;
  private enabled: boolean = false;

  constructor(
    predictor: Predictor,
    scorer: MultiObjectiveScorer,
    registry: WorkerRegistry,
    maxResults: number = 10000
  ) {
    this.predictor = predictor;
    this.scorer = scorer;
    this.registry = registry;
    this.maxResults = maxResults;
  }

  /**
   * Enable shadow mode
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable shadow mode
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Check if shadow mode is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Run shadow comparison for a task
   */
  async shadow(
    task: Task,
    actualDecision: SchedulingDecision | null
  ): Promise<ShadowResult> {
    // Get predictive decision
    const prediction = await this.predictor.predict(task);
    const workers = this.registry.getAvailable(task.metadata?.requiredCapabilities);
    const scoringResult = this.scorer.score(task, workers, prediction);

    // Build result
    const result: ShadowResult = {
      taskId: task.id,
      predictive: scoringResult
        ? {
            workerId: scoringResult.workerId,
            score: scoringResult.score,
            reasoning: scoringResult.reasoning,
          }
        : null,
      actual: actualDecision
        ? {
            workerId: actualDecision.workerId,
            reason: actualDecision.reason,
          }
        : null,
      match:
        scoringResult?.workerId === actualDecision?.workerId ||
        (!scoringResult && !actualDecision),
      improvement: null,
      timestamp: new Date(),
    };

    // Calculate improvement if both decisions exist
    if (scoringResult && actualDecision) {
      // Score actual worker
      const actualWorker = workers.find((w) => w.id === actualDecision.workerId);
      if (actualWorker) {
        const actualScore = this.scorer.score(task, [actualWorker], prediction);
        if (actualScore) {
          result.improvement = scoringResult.score - actualScore.score;
        }
      }
    }

    // Store result
    if (this.enabled) {
      this.results.push(result);
      if (this.results.length > this.maxResults) {
        this.results.shift();
      }
    }

    return result;
  }

  /**
   * Get shadow mode statistics
   */
  getStats(): ShadowStats {
    const stats: ShadowStats = {
      total: this.results.length,
      matches: 0,
      matchRate: 0,
      improvements: 0,
      avgImprovement: 0,
      byTaskType: new Map(),
    };

    if (this.results.length === 0) {
      return stats;
    }

    let totalImprovement = 0;
    const taskTypeStats = new Map<string, { total: number; matches: number }>();

    for (const result of this.results) {
      if (result.match) {
        stats.matches++;
      }

      if (result.improvement !== null && result.improvement > 0) {
        stats.improvements++;
        totalImprovement += result.improvement;
      }

      // Track by task type (extract from taskId or use default)
      const taskType = 'default'; // Would need task type in result
      const typeStats = taskTypeStats.get(taskType) || { total: 0, matches: 0 };
      typeStats.total++;
      if (result.match) typeStats.matches++;
      taskTypeStats.set(taskType, typeStats);
    }

    stats.matchRate = stats.matches / stats.total;
    stats.avgImprovement =
      stats.improvements > 0 ? totalImprovement / stats.improvements : 0;
    stats.byTaskType = taskTypeStats;

    return stats;
  }

  /**
   * Get recent results
   */
  getRecentResults(count: number = 100): ShadowResult[] {
    return this.results.slice(-count);
  }

  /**
   * Clear results
   */
  clear(): void {
    this.results = [];
  }

  /**
   * Get improvement analysis
   */
  getImprovementAnalysis(): {
    wouldImprove: number;
    wouldWorsen: number;
    noChange: number;
    avgPositiveGain: number;
    avgNegativeLoss: number;
  } {
    let wouldImprove = 0;
    let wouldWorsen = 0;
    let noChange = 0;
    let totalPositiveGain = 0;
    let totalNegativeLoss = 0;

    for (const result of this.results) {
      if (result.improvement === null || result.improvement === 0) {
        noChange++;
      } else if (result.improvement > 0) {
        wouldImprove++;
        totalPositiveGain += result.improvement;
      } else {
        wouldWorsen++;
        totalNegativeLoss += Math.abs(result.improvement);
      }
    }

    return {
      wouldImprove,
      wouldWorsen,
      noChange,
      avgPositiveGain: wouldImprove > 0 ? totalPositiveGain / wouldImprove : 0,
      avgNegativeLoss: wouldWorsen > 0 ? totalNegativeLoss / wouldWorsen : 0,
    };
  }
}
