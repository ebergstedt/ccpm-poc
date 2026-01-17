/**
 * Tests for Prometheus Metrics
 */

import {
  SchedulerMetrics,
  getMetrics,
  resetGlobalMetrics,
  DecisionStatus,
} from './prometheus';

describe('SchedulerMetrics', () => {
  let metrics: SchedulerMetrics;

  beforeEach(() => {
    // Create fresh instance without default metrics to avoid conflicts
    metrics = new SchedulerMetrics({
      collectDefaultMetrics: false,
      prefix: 'test_scheduler_',
    });
  });

  afterEach(() => {
    metrics.clear();
  });

  describe('constructor', () => {
    it('should create metrics with default config', () => {
      const defaultMetrics = new SchedulerMetrics({
        collectDefaultMetrics: false,
      });
      expect(defaultMetrics).toBeInstanceOf(SchedulerMetrics);
      expect(defaultMetrics.decisionsTotal).toBeDefined();
      expect(defaultMetrics.decisionLatency).toBeDefined();
      expect(defaultMetrics.workersActive).toBeDefined();
      defaultMetrics.clear();
    });

    it('should create metrics with custom prefix', () => {
      const customMetrics = new SchedulerMetrics({
        collectDefaultMetrics: false,
        prefix: 'custom_',
      });
      expect(customMetrics).toBeInstanceOf(SchedulerMetrics);
      customMetrics.clear();
    });
  });

  describe('recordDecision', () => {
    it('should record successful decision', async () => {
      metrics.recordDecision('success', 10);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_decisions_total');
      expect(output).toContain('status="success"');
    });

    it('should record fallback decision', async () => {
      metrics.recordDecision('fallback', 5);
      const output = await metrics.getMetrics();
      expect(output).toContain('status="fallback"');
    });

    it('should record error decision', async () => {
      metrics.recordDecision('error', 100);
      const output = await metrics.getMetrics();
      expect(output).toContain('status="error"');
    });

    it('should record latency histogram', async () => {
      metrics.recordDecision('success', 50);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_decision_latency_ms');
    });
  });

  describe('recordDispatch', () => {
    it('should record task dispatch', async () => {
      metrics.recordDispatch('task-type-a', 'worker-1');
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_tasks_dispatched_total');
      expect(output).toContain('task_type="task-type-a"');
      expect(output).toContain('worker_id="worker-1"');
    });

    it('should increment counter for multiple dispatches', async () => {
      metrics.recordDispatch('task-type-a', 'worker-1');
      metrics.recordDispatch('task-type-a', 'worker-1');
      metrics.recordDispatch('task-type-b', 'worker-2');
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_tasks_dispatched_total');
    });
  });

  describe('recordDispatchError', () => {
    it('should record dispatch error', async () => {
      metrics.recordDispatchError('timeout');
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_dispatch_errors_total');
      expect(output).toContain('error_type="timeout"');
    });
  });

  describe('updateWorkerCounts', () => {
    it('should update worker counts by health status', async () => {
      metrics.updateWorkerCounts(5, 2, 1);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_workers_active');
      expect(output).toContain('status="healthy"');
      expect(output).toContain('status="degraded"');
      expect(output).toContain('status="unhealthy"');
    });
  });

  describe('recordPredictionAccuracy', () => {
    it('should record prediction accuracy ratio', async () => {
      metrics.recordPredictionAccuracy(100, 100); // ratio = 1.0
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_prediction_accuracy_ratio');
    });

    it('should handle different ratios', async () => {
      metrics.recordPredictionAccuracy(50, 100); // ratio = 0.5
      metrics.recordPredictionAccuracy(150, 100); // ratio = 1.5
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_prediction_accuracy_ratio');
    });

    it('should not record when actual is 0', async () => {
      metrics.recordPredictionAccuracy(100, 0);
      const output = await metrics.getMetrics();
      // Should still have the metric defined but no observations
      expect(output).toContain('test_scheduler_prediction_accuracy_ratio');
    });
  });

  describe('updateQueueDepth', () => {
    it('should update queue depth gauge', async () => {
      metrics.updateQueueDepth(42);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_queue_depth 42');
    });
  });

  describe('recordQueueWaitTime', () => {
    it('should record queue wait time', async () => {
      metrics.recordQueueWaitTime(500);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_scheduler_queue_wait_time_ms');
    });
  });

  describe('getMetrics', () => {
    it('should return metrics in Prometheus text format', async () => {
      metrics.recordDecision('success', 10);
      const output = await metrics.getMetrics();
      expect(typeof output).toBe('string');
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
    });
  });

  describe('getContentType', () => {
    it('should return Prometheus content type', () => {
      const contentType = metrics.getContentType();
      expect(contentType).toContain('text/plain');
    });
  });

  describe('reset', () => {
    it('should reset all metric values', async () => {
      metrics.recordDecision('success', 10);
      metrics.updateQueueDepth(100);
      metrics.reset();
      const output = await metrics.getMetrics();
      // After reset, counters should be at 0
      expect(output).not.toContain('decisions_total{status="success"} 1');
    });
  });
});

describe('Global Metrics', () => {
  afterEach(() => {
    resetGlobalMetrics();
  });

  it('should return singleton instance', () => {
    const metrics1 = getMetrics({ collectDefaultMetrics: false });
    const metrics2 = getMetrics();
    expect(metrics1).toBe(metrics2);
  });

  it('should reset global instance', () => {
    const metrics1 = getMetrics({ collectDefaultMetrics: false });
    resetGlobalMetrics();
    const metrics2 = getMetrics({ collectDefaultMetrics: false });
    expect(metrics1).not.toBe(metrics2);
  });
});
