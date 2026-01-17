/**
 * Unit tests for Dispatcher
 */

import { Dispatcher } from './dispatcher';
import { WorkerRegistry } from '../registry/worker-registry';
import { Predictor, NoOpPredictor } from '../interfaces/predictor';
import { Task, TaskPrediction, WorkerState } from '../interfaces/types';

// Mock ioredis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
    xgroup: jest.fn().mockResolvedValue('OK'),
    xreadgroup: jest.fn().mockResolvedValue(null),
    xack: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  }));
});

describe('Dispatcher', () => {
  let registry: WorkerRegistry;
  let predictor: Predictor;
  let dispatcher: Dispatcher;

  const createTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    type: 'test',
    payload: {},
    priority: 0,
    createdAt: new Date(),
    ...overrides,
  });

  const createWorker = (
    id: string,
    overrides: Partial<WorkerState> = {}
  ): WorkerState => ({
    id,
    status: 'idle',
    capabilities: ['default'],
    currentLoad: 0,
    lastHeartbeat: new Date(),
    activeTasks: 0,
    maxConcurrency: 10,
    ...overrides,
  });

  beforeEach(() => {
    registry = new WorkerRegistry(30000);
    predictor = new NoOpPredictor();
    dispatcher = new Dispatcher(predictor, registry, {
      redisUrl: 'redis://localhost:6379',
      fallbackThreshold: 3,
    });
  });

  afterEach(async () => {
    dispatcher.stop();
    registry.clear();
  });

  describe('dispatchTask', () => {
    beforeEach(async () => {
      await dispatcher.connect();
    });

    afterEach(async () => {
      await dispatcher.disconnect();
    });

    it('should dispatch task using round-robin when no prediction', async () => {
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));

      const task = createTask('task-1');
      const result = await dispatcher.dispatchTask(task);

      expect(result.success).toBe(true);
      expect(result.decision.usedFallback).toBe(true);
      expect(result.decision.reason).toBe('fallback_round_robin');
      expect(['worker-1', 'worker-2']).toContain(result.decision.workerId);
    });

    it('should use prediction when available', async () => {
      registry.register(createWorker('worker-1'));
      registry.register(createWorker('worker-2'));

      const mockPredictor: Predictor = {
        predict: jest.fn().mockResolvedValue({
          taskId: 'task-1',
          recommendedWorkerId: 'worker-1',
          confidence: 0.9,
          estimatedDurationMs: 1000,
        } as TaskPrediction),
      };

      const predictorDispatcher = new Dispatcher(mockPredictor, registry, {
        redisUrl: 'redis://localhost:6379',
      });
      await predictorDispatcher.connect();

      const task = createTask('task-1');
      const result = await predictorDispatcher.dispatchTask(task);

      expect(result.success).toBe(true);
      expect(result.decision.usedFallback).toBe(false);
      expect(result.decision.reason).toBe('prediction');
      expect(result.decision.workerId).toBe('worker-1');
      expect(result.decision.prediction).toBeDefined();

      await predictorDispatcher.disconnect();
    });

    it('should return error when no workers available', async () => {
      const task = createTask('task-1');
      const result = await dispatcher.dispatchTask(task);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No workers available');
    });

    it('should fall back when predicted worker is offline', async () => {
      registry.register(createWorker('worker-1', { status: 'offline' }));
      registry.register(createWorker('worker-2'));

      const mockPredictor: Predictor = {
        predict: jest.fn().mockResolvedValue({
          taskId: 'task-1',
          recommendedWorkerId: 'worker-1',
          confidence: 0.9,
          estimatedDurationMs: 1000,
        } as TaskPrediction),
      };

      const predictorDispatcher = new Dispatcher(mockPredictor, registry, {
        redisUrl: 'redis://localhost:6379',
      });
      await predictorDispatcher.connect();

      const task = createTask('task-1');
      const result = await predictorDispatcher.dispatchTask(task);

      expect(result.success).toBe(true);
      expect(result.decision.usedFallback).toBe(true);
      expect(result.decision.workerId).toBe('worker-2');

      await predictorDispatcher.disconnect();
    });
  });

  describe('circuit breaker', () => {
    beforeEach(async () => {
      await dispatcher.connect();
    });

    afterEach(async () => {
      await dispatcher.disconnect();
    });

    it('should open circuit breaker after threshold failures', async () => {
      registry.register(createWorker('worker-1'));

      const failingPredictor: Predictor = {
        predict: jest.fn().mockRejectedValue(new Error('Prediction failed')),
      };

      const predictorDispatcher = new Dispatcher(failingPredictor, registry, {
        redisUrl: 'redis://localhost:6379',
        fallbackThreshold: 3,
      });
      await predictorDispatcher.connect();

      // Trigger 3 failures
      for (let i = 0; i < 3; i++) {
        const task = createTask(`task-${i}`);
        await predictorDispatcher.dispatchTask(task);
      }

      const state = predictorDispatcher.getCircuitBreakerState();
      expect(state.isOpen).toBe(true);
      expect(state.failures).toBe(3);

      await predictorDispatcher.disconnect();
    });

    it('should use fallback_circuit_breaker reason when circuit is open', async () => {
      registry.register(createWorker('worker-1'));

      const failingPredictor: Predictor = {
        predict: jest.fn().mockRejectedValue(new Error('Prediction failed')),
      };

      const predictorDispatcher = new Dispatcher(failingPredictor, registry, {
        redisUrl: 'redis://localhost:6379',
        fallbackThreshold: 2,
      });
      await predictorDispatcher.connect();

      // Trigger failures to open circuit
      await predictorDispatcher.dispatchTask(createTask('task-1'));
      await predictorDispatcher.dispatchTask(createTask('task-2'));

      // Next dispatch should show circuit breaker reason
      const result = await predictorDispatcher.dispatchTask(createTask('task-3'));
      expect(result.decision.reason).toBe('fallback_circuit_breaker');

      await predictorDispatcher.disconnect();
    });

    it('should reset circuit breaker on successful prediction', async () => {
      registry.register(createWorker('worker-1'));

      let failCount = 0;
      const sometimesFailingPredictor: Predictor = {
        predict: jest.fn().mockImplementation(async () => {
          failCount++;
          if (failCount <= 2) {
            throw new Error('Prediction failed');
          }
          return {
            taskId: 'task',
            recommendedWorkerId: 'worker-1',
            confidence: 0.9,
            estimatedDurationMs: 1000,
          };
        }),
      };

      const predictorDispatcher = new Dispatcher(
        sometimesFailingPredictor,
        registry,
        {
          redisUrl: 'redis://localhost:6379',
          fallbackThreshold: 3,
        }
      );
      await predictorDispatcher.connect();

      // Trigger 2 failures (below threshold)
      await predictorDispatcher.dispatchTask(createTask('task-1'));
      await predictorDispatcher.dispatchTask(createTask('task-2'));

      let state = predictorDispatcher.getCircuitBreakerState();
      expect(state.failures).toBe(2);
      expect(state.isOpen).toBe(false);

      // Successful prediction should reset
      await predictorDispatcher.dispatchTask(createTask('task-3'));

      state = predictorDispatcher.getCircuitBreakerState();
      expect(state.failures).toBe(0);
      expect(state.isOpen).toBe(false);

      await predictorDispatcher.disconnect();
    });
  });

  describe('connect/disconnect', () => {
    it('should connect to Redis', async () => {
      await expect(dispatcher.connect()).resolves.not.toThrow();
      await dispatcher.disconnect();
    });

    it('should disconnect from Redis', async () => {
      await dispatcher.connect();
      await expect(dispatcher.disconnect()).resolves.not.toThrow();
    });
  });

  describe('isRunning', () => {
    it('should return false by default', () => {
      expect(dispatcher.isRunning()).toBe(false);
    });

    it('should return true after start', async () => {
      await dispatcher.connect();
      await dispatcher.start();

      expect(dispatcher.isRunning()).toBe(true);

      dispatcher.stop();
      await dispatcher.disconnect();
    });

    it('should return false after stop', async () => {
      await dispatcher.connect();
      await dispatcher.start();
      dispatcher.stop();

      expect(dispatcher.isRunning()).toBe(false);

      await dispatcher.disconnect();
    });
  });
});
