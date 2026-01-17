/**
 * Performance Benchmark - Verify scheduling meets latency targets
 */

import { Task } from '../interfaces/types';
import { Predictor } from '../interfaces/predictor';
import { MultiObjectiveScorer } from '../scorer/scorer';
import { WorkerRegistry } from '../registry/worker-registry';

/**
 * Benchmark result
 */
export interface BenchmarkResult {
  name: string;
  throughput: number; // tasks/sec
  latency: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    min: number;
    avg: number;
  };
  memoryMB: number;
  samples: number;
  success: boolean;
  errors: number;
}

/**
 * Benchmark configuration
 */
export interface BenchmarkConfig {
  targetThroughput: number; // Target tasks/sec (default: 100)
  targetP99: number; // Target p99 latency in ms (default: 10)
  durationMs: number; // How long to run (default: 10000)
  warmupMs: number; // Warmup period (default: 1000)
}

/**
 * Default benchmark configuration
 */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  targetThroughput: 100,
  targetP99: 10,
  durationMs: 10000,
  warmupMs: 1000,
};

/**
 * Calculate percentiles from sorted array
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Get memory usage in MB
 */
function getMemoryMB(): number {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    return process.memoryUsage().heapUsed / 1024 / 1024;
  }
  return 0;
}

/**
 * Benchmark runner
 */
export class Benchmark {
  private config: BenchmarkConfig;

  constructor(config: Partial<BenchmarkConfig> = {}) {
    this.config = {
      ...DEFAULT_BENCHMARK_CONFIG,
      ...config,
    };
  }

  /**
   * Run scheduling benchmark
   */
  async runSchedulingBenchmark(
    scorer: MultiObjectiveScorer,
    predictor: Predictor,
    registry: WorkerRegistry,
    taskGenerator: () => Task
  ): Promise<BenchmarkResult> {
    const latencies: number[] = [];
    let errors = 0;
    const startMemory = getMemoryMB();

    // Warmup phase
    const warmupEnd = Date.now() + this.config.warmupMs;
    while (Date.now() < warmupEnd) {
      const task = taskGenerator();
      try {
        const prediction = await predictor.predict(task);
        const workers = registry.getAvailable();
        scorer.score(task, workers, prediction);
      } catch {
        // Ignore warmup errors
      }
    }

    // Benchmark phase
    const benchmarkEnd = Date.now() + this.config.durationMs;
    const startTime = Date.now();

    while (Date.now() < benchmarkEnd) {
      const task = taskGenerator();
      const opStart = performance.now();

      try {
        const prediction = await predictor.predict(task);
        const workers = registry.getAvailable();
        scorer.score(task, workers, prediction);
      } catch {
        errors++;
      }

      const opEnd = performance.now();
      latencies.push(opEnd - opStart);
    }

    const totalTime = Date.now() - startTime;
    const endMemory = getMemoryMB();

    // Calculate statistics
    latencies.sort((a, b) => a - b);

    const result: BenchmarkResult = {
      name: 'Scheduling Benchmark',
      throughput: (latencies.length / totalTime) * 1000,
      latency: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1],
        min: latencies[0],
        avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      },
      memoryMB: endMemory - startMemory,
      samples: latencies.length,
      success:
        latencies.length > 0 &&
        percentile(latencies, 99) < this.config.targetP99 &&
        (latencies.length / totalTime) * 1000 >= this.config.targetThroughput,
      errors,
    };

    return result;
  }

  /**
   * Run predictor benchmark
   */
  async runPredictorBenchmark(
    predictor: Predictor,
    taskGenerator: () => Task
  ): Promise<BenchmarkResult> {
    const latencies: number[] = [];
    let errors = 0;
    const startMemory = getMemoryMB();

    // Warmup
    const warmupEnd = Date.now() + this.config.warmupMs;
    while (Date.now() < warmupEnd) {
      const task = taskGenerator();
      try {
        await predictor.predict(task);
      } catch {
        // Ignore
      }
    }

    // Benchmark
    const benchmarkEnd = Date.now() + this.config.durationMs;
    const startTime = Date.now();

    while (Date.now() < benchmarkEnd) {
      const task = taskGenerator();
      const opStart = performance.now();

      try {
        await predictor.predict(task);
      } catch {
        errors++;
      }

      const opEnd = performance.now();
      latencies.push(opEnd - opStart);
    }

    const totalTime = Date.now() - startTime;
    const endMemory = getMemoryMB();

    latencies.sort((a, b) => a - b);

    return {
      name: 'Predictor Benchmark',
      throughput: (latencies.length / totalTime) * 1000,
      latency: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1] || 0,
        min: latencies[0] || 0,
        avg: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      },
      memoryMB: endMemory - startMemory,
      samples: latencies.length,
      success: latencies.length > 0 && percentile(latencies, 99) < 1, // < 1ms for predictor
      errors,
    };
  }

  /**
   * Format benchmark results for display
   */
  formatResults(result: BenchmarkResult): string {
    const lines = [
      `=== ${result.name} ===`,
      `Throughput: ${result.throughput.toFixed(1)} ops/sec`,
      `Latency:`,
      `  p50: ${result.latency.p50.toFixed(2)}ms`,
      `  p90: ${result.latency.p90.toFixed(2)}ms`,
      `  p95: ${result.latency.p95.toFixed(2)}ms`,
      `  p99: ${result.latency.p99.toFixed(2)}ms`,
      `  max: ${result.latency.max.toFixed(2)}ms`,
      `  avg: ${result.latency.avg.toFixed(2)}ms`,
      `Memory: ${result.memoryMB.toFixed(2)}MB`,
      `Samples: ${result.samples}`,
      `Errors: ${result.errors}`,
      `Success: ${result.success ? 'PASS' : 'FAIL'}`,
    ];
    return lines.join('\n');
  }
}
