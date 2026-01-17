/**
 * Unit tests for SchedulerHandlers
 */

import { Request, Response } from 'express';
import { SchedulerHandlers } from './handlers';
import { WorkerRegistry } from '../registry/worker-registry';
import { NoOpPredictor } from '../interfaces/predictor';
import { SchedulerConfig, WorkerState } from '../interfaces/types';

// Mock Dispatcher
class MockDispatcher {
  private _isRunning = true;

  dispatchTask = jest.fn().mockResolvedValue({
    success: true,
    decision: {
      taskId: 'test-task',
      workerId: 'worker-1',
      timestamp: new Date(),
      usedFallback: false,
      reason: 'prediction',
    },
  });

  isRunning(): boolean {
    return this._isRunning;
  }

  setRunning(value: boolean): void {
    this._isRunning = value;
  }
}

// Mock Express Request and Response
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    correlationId: 'test-correlation-id',
    params: {},
    body: {},
    ...overrides,
  };
}

function createMockResponse(): Partial<Response> & { data: unknown; statusCode: number } {
  const res: Partial<Response> & { data: unknown; statusCode: number } = {
    data: null,
    statusCode: 200,
  };

  res.json = jest.fn().mockImplementation((data) => {
    res.data = data;
    return res;
  });

  res.status = jest.fn().mockImplementation((code) => {
    res.statusCode = code;
    return res;
  });

  return res;
}

describe('SchedulerHandlers', () => {
  let registry: WorkerRegistry;
  let dispatcher: MockDispatcher;
  let predictor: NoOpPredictor;
  let config: SchedulerConfig;
  let handlers: SchedulerHandlers;

  beforeEach(() => {
    registry = new WorkerRegistry(30000);
    dispatcher = new MockDispatcher();
    predictor = new NoOpPredictor();
    config = {
      redisUrl: 'redis://localhost:6379',
      fallbackThreshold: 3,
      heartbeatTimeoutMs: 30000,
    };
    handlers = new SchedulerHandlers(
      registry,
      dispatcher as unknown as ConstructorParameters<typeof SchedulerHandlers>[1],
      predictor,
      config
    );
  });

  describe('getStatus', () => {
    it('should return healthy status when no workers exist', () => {
      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      expect(res.json).toHaveBeenCalled();
      expect(res.data).toMatchObject({
        status: 'healthy',
        workers: { healthy: 0, degraded: 0, unhealthy: 0 },
        predictions: { taskTypes: 0, avgConfidence: 0 },
        decisions: { total: 0, fallbackRate: 0 },
        latency: { p50: 0, p99: 0 },
      });
      expect((res.data as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
    });

    it('should count healthy workers correctly', () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'idle',
        capabilities: ['cpu'],
        currentLoad: 0.3,
        lastHeartbeat: new Date(),
        activeTasks: 1,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      expect(res.data).toMatchObject({
        workers: { healthy: 1, degraded: 0, unhealthy: 0 },
      });
    });

    it('should count degraded workers (high load)', () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'idle',
        capabilities: ['cpu'],
        currentLoad: 0.9, // High load = degraded
        lastHeartbeat: new Date(),
        activeTasks: 4,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      expect(res.data).toMatchObject({
        workers: { healthy: 0, degraded: 1, unhealthy: 0 },
      });
    });

    it('should count unhealthy workers (offline)', () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'offline',
        capabilities: ['cpu'],
        currentLoad: 0,
        lastHeartbeat: new Date(),
        activeTasks: 0,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      expect(res.data).toMatchObject({
        workers: { healthy: 0, degraded: 0, unhealthy: 1 },
      });
    });

    it('should return unhealthy status when dispatcher is not running', () => {
      dispatcher.setRunning(false);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      expect(res.data).toMatchObject({
        status: 'unhealthy',
      });
    });
  });

  describe('getWorkers', () => {
    it('should return empty list when no workers registered', () => {
      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getWorkers(req as Request, res as Response);

      expect(res.data).toEqual({
        workers: [],
        total: 0,
        available: 0,
      });
    });

    it('should return all registered workers', () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'idle',
        capabilities: ['cpu'],
        currentLoad: 0.3,
        lastHeartbeat: new Date(),
        activeTasks: 1,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getWorkers(req as Request, res as Response);

      const data = res.data as { workers: WorkerState[]; total: number; available: number };
      expect(data.workers).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.available).toBe(1);
    });
  });

  describe('getPredictions', () => {
    it('should return empty predictions initially', () => {
      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getPredictions(req as Request, res as Response);

      expect(res.data).toEqual({
        taskTypes: [],
        states: {},
      });
    });

    it('should return recorded prediction stats', () => {
      handlers.recordDecision('image-processing', 0.85, false, 5);
      handlers.recordDecision('image-processing', 0.90, false, 3);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getPredictions(req as Request, res as Response);

      const data = res.data as { taskTypes: string[]; states: Record<string, unknown> };
      expect(data.taskTypes).toContain('image-processing');
      expect(data.states['image-processing']).toMatchObject({
        totalPredictions: 2,
      });
    });
  });

  describe('updateConfig', () => {
    it('should update fallbackThreshold', () => {
      const req = createMockRequest({
        body: { fallbackThreshold: 5 },
      });
      const res = createMockResponse();

      handlers.updateConfig(req as Request, res as Response);

      expect(res.data).toMatchObject({
        message: 'Configuration updated',
        config: { fallbackThreshold: 5 },
      });
      expect(handlers.getConfig().fallbackThreshold).toBe(5);
    });

    it('should update heartbeatTimeoutMs', () => {
      const req = createMockRequest({
        body: { heartbeatTimeoutMs: 60000 },
      });
      const res = createMockResponse();

      handlers.updateConfig(req as Request, res as Response);

      expect(res.data).toMatchObject({
        message: 'Configuration updated',
        config: { heartbeatTimeoutMs: 60000 },
      });
    });

    it('should reject invalid fallbackThreshold', () => {
      const req = createMockRequest({
        body: { fallbackThreshold: 0 },
      });
      const res = createMockResponse();

      handlers.updateConfig(req as Request, res as Response);

      expect(res.statusCode).toBe(400);
      expect(res.data).toMatchObject({
        error: 'Bad Request',
      });
    });

    it('should reject invalid heartbeatTimeoutMs', () => {
      const req = createMockRequest({
        body: { heartbeatTimeoutMs: 500 },
      });
      const res = createMockResponse();

      handlers.updateConfig(req as Request, res as Response);

      expect(res.statusCode).toBe(400);
      expect(res.data).toMatchObject({
        error: 'Bad Request',
      });
    });
  });

  describe('override', () => {
    it('should reject missing required fields', async () => {
      const req = createMockRequest({
        body: { taskId: 'test-task' }, // Missing taskType and workerId
      });
      const res = createMockResponse();

      await handlers.override(req as Request, res as Response);

      expect(res.statusCode).toBe(400);
      expect(res.data).toMatchObject({
        error: 'Bad Request',
        message: 'taskId, taskType, and workerId are required',
      });
    });

    it('should reject when worker not found', async () => {
      const req = createMockRequest({
        body: {
          taskId: 'test-task',
          taskType: 'image-processing',
          workerId: 'nonexistent-worker',
        },
      });
      const res = createMockResponse();

      await handlers.override(req as Request, res as Response);

      expect(res.statusCode).toBe(404);
      expect(res.data).toMatchObject({
        error: 'Not Found',
      });
    });

    it('should reject when worker is offline', async () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'offline',
        capabilities: ['cpu'],
        currentLoad: 0,
        lastHeartbeat: new Date(),
        activeTasks: 0,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest({
        body: {
          taskId: 'test-task',
          taskType: 'image-processing',
          workerId: 'worker-1',
        },
      });
      const res = createMockResponse();

      await handlers.override(req as Request, res as Response);

      expect(res.statusCode).toBe(400);
      expect(res.data).toMatchObject({
        error: 'Bad Request',
        message: 'Worker worker-1 is offline and cannot accept tasks',
      });
    });

    it('should successfully dispatch override task', async () => {
      const worker: WorkerState = {
        id: 'worker-1',
        status: 'idle',
        capabilities: ['cpu'],
        currentLoad: 0.3,
        lastHeartbeat: new Date(),
        activeTasks: 1,
        maxConcurrency: 5,
      };
      registry.register(worker);

      const req = createMockRequest({
        body: {
          taskId: 'test-task',
          taskType: 'image-processing',
          workerId: 'worker-1',
          payload: { data: 'test' },
        },
      });
      const res = createMockResponse();

      await handlers.override(req as Request, res as Response);

      expect(res.statusCode).toBe(200);
      expect(res.data).toMatchObject({
        success: true,
        taskId: 'test-task',
        message: 'Task manually assigned to worker',
      });
      expect(dispatcher.dispatchTask).toHaveBeenCalled();
    });
  });

  describe('resetPredictions', () => {
    it('should reset existing predictions', () => {
      handlers.recordDecision('image-processing', 0.85, false, 5);

      const req = createMockRequest({
        params: { taskType: 'image-processing' },
      });
      const res = createMockResponse();

      handlers.resetPredictions(req as Request, res as Response);

      expect(res.data).toMatchObject({
        reset: true,
        taskType: 'image-processing',
      });

      // Verify predictions are cleared
      const predReq = createMockRequest();
      const predRes = createMockResponse();
      handlers.getPredictions(predReq as Request, predRes as Response);

      const predData = predRes.data as { taskTypes: string[] };
      expect(predData.taskTypes).not.toContain('image-processing');
    });

    it('should handle non-existent task type', () => {
      const req = createMockRequest({
        params: { taskType: 'nonexistent-type' },
      });
      const res = createMockResponse();

      handlers.resetPredictions(req as Request, res as Response);

      expect(res.data).toMatchObject({
        reset: false,
        taskType: 'nonexistent-type',
      });
    });

    it('should reject missing taskType parameter', () => {
      const req = createMockRequest({
        params: {},
      });
      const res = createMockResponse();

      handlers.resetPredictions(req as Request, res as Response);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('recordDecision', () => {
    it('should track decision metrics', () => {
      handlers.recordDecision('task-a', 0.9, false, 5);
      handlers.recordDecision('task-b', 0.7, true, 10);
      handlers.recordDecision('task-a', 0.85, false, 3);

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      const data = res.data as {
        decisions: { total: number; fallbackRate: number };
        predictions: { taskTypes: number };
      };
      expect(data.decisions.total).toBe(3);
      expect(data.decisions.fallbackRate).toBeCloseTo(0.33, 1);
      expect(data.predictions.taskTypes).toBe(2);
    });

    it('should calculate latency percentiles correctly', () => {
      // Record 100 decisions with varying latencies
      for (let i = 1; i <= 100; i++) {
        handlers.recordDecision('task', 0.8, false, i);
      }

      const req = createMockRequest();
      const res = createMockResponse();

      handlers.getStatus(req as Request, res as Response);

      const data = res.data as { latency: { p50: number; p99: number } };
      // p50 should be around 50 (allowing for index calculation variance)
      expect(data.latency.p50).toBeGreaterThanOrEqual(49);
      expect(data.latency.p50).toBeLessThanOrEqual(51);
      // p99 should be around 99
      expect(data.latency.p99).toBeGreaterThanOrEqual(98);
      expect(data.latency.p99).toBeLessThanOrEqual(100);
    });
  });
});
