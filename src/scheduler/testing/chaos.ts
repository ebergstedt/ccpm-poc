/**
 * Chaos Testing - Failure injection for resilience testing
 */

import { Predictor } from '../interfaces/predictor';
import { Task, TaskPrediction } from '../interfaces/types';

/**
 * Failure injection types
 */
export type FailureType =
  | 'prediction_failure' // Predictor throws error
  | 'prediction_timeout' // Predictor times out
  | 'prediction_null' // Predictor returns null
  | 'worker_unhealthy' // All workers become unhealthy
  | 'redis_slow' // Redis operations are slow
  | 'clickhouse_unavailable'; // ClickHouse is unavailable

/**
 * Chaos configuration
 */
export interface ChaosConfig {
  enabled: boolean;
  failureRate: number; // 0-1, probability of failure
  failureType: FailureType;
  failureDurationMs: number; // How long failure lasts
  delayMs?: number; // Delay to inject (for timeout/slow failures)
}

/**
 * Default chaos config (disabled)
 */
export const DEFAULT_CHAOS_CONFIG: ChaosConfig = {
  enabled: false,
  failureRate: 0.1,
  failureType: 'prediction_failure',
  failureDurationMs: 5000,
  delayMs: 100,
};

/**
 * Chaos test result
 */
export interface ChaosTestResult {
  testName: string;
  passed: boolean;
  failureType: FailureType;
  totalRequests: number;
  failedRequests: number;
  recoveryTimeMs: number | null;
  fallbackTriggered: boolean;
  errors: string[];
}

/**
 * ChaosPredictor wraps a predictor with failure injection
 */
export class ChaosPredictor implements Predictor {
  private inner: Predictor;
  private config: ChaosConfig;
  private failureStartTime: number | null = null;

  constructor(inner: Predictor, config: Partial<ChaosConfig> = {}) {
    this.inner = inner;
    this.config = {
      ...DEFAULT_CHAOS_CONFIG,
      ...config,
    };
  }

  /**
   * Enable chaos
   */
  enable(failureType?: FailureType): void {
    this.config.enabled = true;
    if (failureType) {
      this.config.failureType = failureType;
    }
    this.failureStartTime = Date.now();
  }

  /**
   * Disable chaos
   */
  disable(): void {
    this.config.enabled = false;
    this.failureStartTime = null;
  }

  /**
   * Update failure rate
   */
  setFailureRate(rate: number): void {
    this.config.failureRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Check if should inject failure
   */
  private shouldFail(): boolean {
    if (!this.config.enabled) return false;

    // Check if failure duration has passed
    if (this.failureStartTime) {
      if (Date.now() - this.failureStartTime > this.config.failureDurationMs) {
        this.disable();
        return false;
      }
    }

    return Math.random() < this.config.failureRate;
  }

  /**
   * Predict with potential failure injection
   */
  async predict(task: Task): Promise<TaskPrediction | null> {
    if (this.shouldFail()) {
      switch (this.config.failureType) {
        case 'prediction_failure':
          throw new Error('Chaos: Prediction failure injected');

        case 'prediction_timeout':
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.delayMs || 1000)
          );
          throw new Error('Chaos: Prediction timeout injected');

        case 'prediction_null':
          return null;

        default:
          // Other failure types don't affect predictor
          break;
      }
    }

    return this.inner.predict(task);
  }

  async isReady(): Promise<boolean> {
    if (this.shouldFail() && this.config.failureType === 'prediction_failure') {
      return false;
    }
    return this.inner.isReady?.() ?? true;
  }

  async feedback(
    taskId: string,
    workerId: string,
    success: boolean,
    actualDurationMs: number,
    taskType?: string
  ): Promise<void> {
    if (this.shouldFail() && this.config.failureType === 'prediction_failure') {
      throw new Error('Chaos: Feedback failure injected');
    }
    return this.inner.feedback?.(taskId, workerId, success, actualDurationMs, taskType);
  }
}

/**
 * Run chaos test scenarios
 */
export class ChaosRunner {
  /**
   * Test predictor failure handling
   */
  async testPredictorFailure(
    predictor: Predictor,
    taskGenerator: () => Task,
    fallbackHandler: (task: Task) => Promise<string | null>,
    iterations: number = 100
  ): Promise<ChaosTestResult> {
    const chaosPredictor = new ChaosPredictor(predictor, {
      enabled: true,
      failureType: 'prediction_failure',
      failureRate: 1.0, // 100% failure
      failureDurationMs: 60000,
    });

    const errors: string[] = [];
    let failedRequests = 0;
    let fallbackTriggered = false;

    for (let i = 0; i < iterations; i++) {
      const task = taskGenerator();

      try {
        await chaosPredictor.predict(task);
        errors.push(`Expected failure but prediction succeeded`);
      } catch {
        // Expected failure
        failedRequests++;

        // Try fallback
        const fallbackResult = await fallbackHandler(task);
        if (fallbackResult !== null) {
          fallbackTriggered = true;
        }
      }
    }

    return {
      testName: 'Predictor Failure Test',
      passed: fallbackTriggered && failedRequests === iterations,
      failureType: 'prediction_failure',
      totalRequests: iterations,
      failedRequests,
      recoveryTimeMs: null,
      fallbackTriggered,
      errors,
    };
  }

  /**
   * Test graceful degradation under partial failures
   */
  async testPartialFailure(
    predictor: Predictor,
    taskGenerator: () => Task,
    fallbackHandler: (task: Task) => Promise<string | null>,
    iterations: number = 100,
    failureRate: number = 0.5
  ): Promise<ChaosTestResult> {
    const chaosPredictor = new ChaosPredictor(predictor, {
      enabled: true,
      failureType: 'prediction_failure',
      failureRate,
      failureDurationMs: 60000,
    });

    const errors: string[] = [];
    let failedRequests = 0;
    let successfulRequests = 0;
    let fallbackTriggered = false;

    for (let i = 0; i < iterations; i++) {
      const task = taskGenerator();

      try {
        const result = await chaosPredictor.predict(task);
        if (result !== null) {
          successfulRequests++;
        }
      } catch {
        failedRequests++;
        const fallbackResult = await fallbackHandler(task);
        if (fallbackResult !== null) {
          fallbackTriggered = true;
        }
      }
    }

    // Test passes if:
    // - Some requests succeeded (not 100% failure)
    // - Some requests failed (chaos worked)
    // - Fallback was triggered for failures
    const expectedFailures = iterations * failureRate;
    const passed =
      successfulRequests > 0 &&
      failedRequests > 0 &&
      fallbackTriggered &&
      Math.abs(failedRequests - expectedFailures) < iterations * 0.2; // Within 20% of expected

    return {
      testName: 'Partial Failure Test',
      passed,
      failureType: 'prediction_failure',
      totalRequests: iterations,
      failedRequests,
      recoveryTimeMs: null,
      fallbackTriggered,
      errors,
    };
  }

  /**
   * Test timeout handling
   */
  async testTimeoutHandling(
    predictor: Predictor,
    taskGenerator: () => Task,
    timeoutMs: number = 100,
    iterations: number = 10
  ): Promise<ChaosTestResult> {
    const chaosPredictor = new ChaosPredictor(predictor, {
      enabled: true,
      failureType: 'prediction_timeout',
      failureRate: 1.0,
      failureDurationMs: 60000,
      delayMs: timeoutMs * 2, // Delay longer than timeout
    });

    const errors: string[] = [];
    let timedOut = 0;

    for (let i = 0; i < iterations; i++) {
      const task = taskGenerator();

      try {
        await Promise.race([
          chaosPredictor.predict(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeoutMs)
          ),
        ]);
      } catch (err) {
        if ((err as Error).message === 'Timeout') {
          timedOut++;
        } else {
          errors.push((err as Error).message);
        }
      }
    }

    return {
      testName: 'Timeout Handling Test',
      passed: timedOut === iterations,
      failureType: 'prediction_timeout',
      totalRequests: iterations,
      failedRequests: timedOut,
      recoveryTimeMs: null,
      fallbackTriggered: false,
      errors,
    };
  }
}
