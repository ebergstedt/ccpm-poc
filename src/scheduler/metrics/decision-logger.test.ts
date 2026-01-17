/**
 * Tests for Decision Logger
 */

import {
  DecisionLogger,
  LogEntry,
  getDecisionLogger,
  resetGlobalDecisionLogger,
  createRequestLogger,
} from './decision-logger';
import { SchedulerMetrics } from './prometheus';
import { ClickHouseWriter } from './clickhouse';
import { Task, SchedulingDecision, WorkerState } from '../interfaces/types';

// Mock dependencies
jest.mock('./clickhouse');

describe('DecisionLogger', () => {
  let logger: DecisionLogger;
  let mockMetrics: jest.Mocked<SchedulerMetrics>;
  let mockClickhouse: jest.Mocked<ClickHouseWriter>;
  let logOutput: LogEntry[];

  const mockTask: Task = {
    id: 'task-123',
    type: 'compute',
    payload: { data: 'test' },
    priority: 1,
    createdAt: new Date(),
  };

  const mockWorker: WorkerState = {
    id: 'worker-1',
    status: 'idle',
    capabilities: ['compute'],
    currentLoad: 0.5,
    lastHeartbeat: new Date(),
    activeTasks: 1,
    maxConcurrency: 10,
  };

  const mockDecision: SchedulingDecision = {
    taskId: 'task-123',
    workerId: 'worker-1',
    timestamp: new Date(),
    usedFallback: false,
    reason: 'prediction',
    prediction: {
      taskId: 'task-123',
      recommendedWorkerId: 'worker-1',
      confidence: 0.9,
      estimatedDurationMs: 100,
    },
  };

  beforeEach(() => {
    logOutput = [];

    mockMetrics = {
      recordDecision: jest.fn(),
      recordDispatch: jest.fn(),
      recordDispatchError: jest.fn(),
      recordPredictionAccuracy: jest.fn(),
      updateQueueDepth: jest.fn(),
    } as unknown as jest.Mocked<SchedulerMetrics>;

    mockClickhouse = {
      write: jest.fn(),
    } as unknown as jest.Mocked<ClickHouseWriter>;

    logger = new DecisionLogger(
      {
        minLevel: 'debug',
        output: (entry) => logOutput.push(entry),
        enableConsole: true,
        enableMetrics: true,
        enableClickHouse: true,
      },
      mockMetrics,
      mockClickhouse
    );
  });

  afterEach(() => {
    resetGlobalDecisionLogger();
  });

  describe('constructor', () => {
    it('should create logger with default config', () => {
      const defaultLogger = new DecisionLogger();
      expect(defaultLogger).toBeInstanceOf(DecisionLogger);
    });

    it('should create logger with custom config', () => {
      expect(logger).toBeInstanceOf(DecisionLogger);
      expect(logger.getCorrelationId()).toBeDefined();
    });
  });

  describe('child', () => {
    it('should create child logger with new correlation ID', () => {
      const child = logger.child();
      expect(child.getCorrelationId()).not.toBe(logger.getCorrelationId());
    });

    it('should create child logger with specified correlation ID', () => {
      const child = logger.child('custom-id');
      expect(child.getCorrelationId()).toBe('custom-id');
    });
  });

  describe('forTask', () => {
    it('should create logger with task-based correlation ID', () => {
      const taskLogger = logger.forTask('task-456');
      expect(taskLogger.getCorrelationId()).toBe('task-task-456');
    });
  });

  describe('logDecisionStart', () => {
    it('should log decision start event', () => {
      logger.logDecisionStart({ task: mockTask });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('scheduling_decision_start');
      expect(logOutput[0].taskId).toBe('task-123');
      expect(logOutput[0].taskType).toBe('compute');
    });
  });

  describe('logDecisionSuccess', () => {
    it('should log successful decision', () => {
      logger.logDecisionSuccess({
        task: mockTask,
        worker: mockWorker,
        decision: mockDecision,
        latencyMs: 10,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('scheduling_decision_success');
      expect(logOutput[0].taskId).toBe('task-123');
      expect(logOutput[0].workerId).toBe('worker-1');
      expect(logOutput[0].latencyMs).toBe(10);
    });

    it('should update Prometheus metrics', () => {
      logger.logDecisionSuccess({
        task: mockTask,
        worker: mockWorker,
        decision: mockDecision,
        latencyMs: 10,
      });

      expect(mockMetrics.recordDecision).toHaveBeenCalledWith('success', 10);
      expect(mockMetrics.recordDispatch).toHaveBeenCalledWith(
        'compute',
        'worker-1'
      );
    });

    it('should write to ClickHouse', () => {
      logger.logDecisionSuccess({
        task: mockTask,
        worker: mockWorker,
        decision: mockDecision,
        latencyMs: 10,
      });

      expect(mockClickhouse.write).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-123',
          taskType: 'compute',
          workerId: 'worker-1',
        })
      );
    });

    it('should record fallback status when used', () => {
      const fallbackDecision: SchedulingDecision = {
        ...mockDecision,
        usedFallback: true,
        reason: 'fallback_round_robin',
      };

      logger.logDecisionSuccess({
        task: mockTask,
        worker: mockWorker,
        decision: fallbackDecision,
        latencyMs: 5,
      });

      expect(mockMetrics.recordDecision).toHaveBeenCalledWith('fallback', 5);
    });
  });

  describe('logDecisionError', () => {
    it('should log error with Error object', () => {
      const error = new Error('Test error');

      logger.logDecisionError({
        task: mockTask,
        error,
        latencyMs: 100,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('scheduling_decision_error');
      expect(logOutput[0].error).toBe('Test error');
    });

    it('should log error with string', () => {
      logger.logDecisionError({
        task: mockTask,
        error: 'String error',
        latencyMs: 50,
      });

      expect(logOutput[0].error).toBe('String error');
    });

    it('should update Prometheus metrics', () => {
      logger.logDecisionError({
        task: mockTask,
        error: 'Test error',
        latencyMs: 100,
      });

      expect(mockMetrics.recordDecision).toHaveBeenCalledWith('error', 100);
      expect(mockMetrics.recordDispatchError).toHaveBeenCalledWith(
        'Test error'
      );
    });
  });

  describe('logFallbackActivation', () => {
    it('should log fallback activation', () => {
      logger.logFallbackActivation('circuit_breaker_open', {
        failures: 5,
      });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('fallback_scheduler_activated');
      expect(logOutput[0].reason).toBe('circuit_breaker_open');
      expect(logOutput[0].failures).toBe(5);
    });
  });

  describe('logWorkerHealthChange', () => {
    it('should log worker health change', () => {
      logger.logWorkerHealthChange(
        'worker-1',
        'healthy',
        'degraded',
        'high latency'
      );

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('worker_health_change');
      expect(logOutput[0].workerId).toBe('worker-1');
      expect(logOutput[0].previousStatus).toBe('healthy');
      expect(logOutput[0].newStatus).toBe('degraded');
    });
  });

  describe('logPredictionAccuracy', () => {
    it('should log prediction accuracy', () => {
      logger.logPredictionAccuracy('task-123', 100, 110);

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('prediction_accuracy');
      expect(logOutput[0].predictedMs).toBe(100);
      expect(logOutput[0].actualMs).toBe(110);
    });

    it('should update Prometheus metrics', () => {
      logger.logPredictionAccuracy('task-123', 100, 110);

      expect(mockMetrics.recordPredictionAccuracy).toHaveBeenCalledWith(
        100,
        110
      );
    });
  });

  describe('logQueueDepth', () => {
    it('should log queue depth', () => {
      logger.logQueueDepth(42);

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('queue_depth');
      expect(logOutput[0].depth).toBe(42);
    });

    it('should update Prometheus metrics', () => {
      logger.logQueueDepth(42);

      expect(mockMetrics.updateQueueDepth).toHaveBeenCalledWith(42);
    });
  });

  describe('log level filtering', () => {
    it('should filter logs below minimum level', () => {
      const infoLogger = new DecisionLogger({
        minLevel: 'info',
        output: (entry) => logOutput.push(entry),
        enableConsole: true,
        enableMetrics: false,
        enableClickHouse: false,
      });

      infoLogger.debug('debug_event', { data: 'test' });
      infoLogger.info('info_event', { data: 'test' });

      expect(logOutput).toHaveLength(1);
      expect(logOutput[0].event).toBe('info_event');
    });

    it('should include logs at minimum level', () => {
      const warnLogger = new DecisionLogger({
        minLevel: 'warn',
        output: (entry) => logOutput.push(entry),
        enableConsole: true,
        enableMetrics: false,
        enableClickHouse: false,
      });

      warnLogger.info('info_event');
      warnLogger.warn('warn_event');
      warnLogger.error('error_event');

      expect(logOutput).toHaveLength(2);
      expect(logOutput[0].event).toBe('warn_event');
      expect(logOutput[1].event).toBe('error_event');
    });
  });

  describe('generic log methods', () => {
    it('should support debug logging', () => {
      logger.debug('test_debug', { key: 'value' });
      expect(logOutput[0].level).toBe('debug');
    });

    it('should support info logging', () => {
      logger.info('test_info', { key: 'value' });
      expect(logOutput[0].level).toBe('info');
    });

    it('should support warn logging', () => {
      logger.warn('test_warn', { key: 'value' });
      expect(logOutput[0].level).toBe('warn');
    });

    it('should support error logging', () => {
      logger.error('test_error', { key: 'value' });
      expect(logOutput[0].level).toBe('error');
    });
  });

  describe('setDependencies', () => {
    it('should update dependencies after construction', () => {
      const newLogger = new DecisionLogger({
        minLevel: 'debug',
        output: (entry) => logOutput.push(entry),
        enableConsole: true,
        enableMetrics: true,
        enableClickHouse: true,
      });

      newLogger.setDependencies(mockMetrics, mockClickhouse);

      newLogger.logDecisionSuccess({
        task: mockTask,
        worker: mockWorker,
        decision: mockDecision,
        latencyMs: 10,
      });

      expect(mockMetrics.recordDecision).toHaveBeenCalled();
      expect(mockClickhouse.write).toHaveBeenCalled();
    });
  });
});

describe('Global Decision Logger', () => {
  afterEach(() => {
    resetGlobalDecisionLogger();
  });

  it('should return singleton instance', () => {
    const logger1 = getDecisionLogger();
    const logger2 = getDecisionLogger();
    expect(logger1).toBe(logger2);
  });

  it('should reset global instance', () => {
    const logger1 = getDecisionLogger();
    resetGlobalDecisionLogger();
    const logger2 = getDecisionLogger();
    expect(logger1).not.toBe(logger2);
  });
});

describe('createRequestLogger', () => {
  afterEach(() => {
    resetGlobalDecisionLogger();
  });

  it('should create logger for specific task', () => {
    const taskLogger = createRequestLogger('task-789');
    expect(taskLogger.getCorrelationId()).toBe('task-task-789');
  });

  it('should use provided base logger', () => {
    const baseLogger = new DecisionLogger();
    const taskLogger = createRequestLogger('task-789', baseLogger);
    expect(taskLogger.getCorrelationId()).toBe('task-task-789');
  });
});
