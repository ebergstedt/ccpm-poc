/**
 * Tests for objective functions
 */

import {
  calculateWaitScore,
  calculateLoadScore,
  calculatePriorityScore,
  estimateWaitTime,
  isWorkerEligible,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_MAX_PRIORITY,
} from './objectives';
import { WorkerState, TaskPrediction } from '../interfaces/types';

describe('Objective Functions', () => {
  describe('calculateWaitScore', () => {
    it('should return 1 for 0 wait time', () => {
      expect(calculateWaitScore(0)).toBe(1);
    });

    it('should return 0 for max wait time', () => {
      expect(calculateWaitScore(DEFAULT_MAX_WAIT_MS)).toBe(0);
    });

    it('should return 0.5 for half max wait time', () => {
      expect(calculateWaitScore(DEFAULT_MAX_WAIT_MS / 2)).toBeCloseTo(0.5);
    });

    it('should clamp at 0 for values above max', () => {
      expect(calculateWaitScore(DEFAULT_MAX_WAIT_MS * 2)).toBe(0);
    });

    it('should return 1 for negative wait time', () => {
      expect(calculateWaitScore(-1000)).toBe(1);
    });

    it('should use custom max wait time', () => {
      expect(calculateWaitScore(50, 100)).toBe(0.5);
    });
  });

  describe('calculateLoadScore', () => {
    it('should return 1 for 0 load', () => {
      expect(calculateLoadScore(0)).toBe(1);
    });

    it('should return 0 for full load', () => {
      expect(calculateLoadScore(1)).toBe(0);
    });

    it('should return 0.5 for half load', () => {
      expect(calculateLoadScore(0.5)).toBe(0.5);
    });

    it('should clamp load above 1', () => {
      expect(calculateLoadScore(1.5)).toBe(0);
    });

    it('should clamp negative load', () => {
      expect(calculateLoadScore(-0.5)).toBe(1);
    });
  });

  describe('calculatePriorityScore', () => {
    it('should return 1 for max priority', () => {
      expect(calculatePriorityScore(DEFAULT_MAX_PRIORITY)).toBe(1);
    });

    it('should return 0 for 0 priority', () => {
      expect(calculatePriorityScore(0)).toBe(0);
    });

    it('should return 0.5 for half max priority', () => {
      expect(calculatePriorityScore(DEFAULT_MAX_PRIORITY / 2)).toBeCloseTo(0.5);
    });

    it('should clamp at 1 for values above max', () => {
      expect(calculatePriorityScore(DEFAULT_MAX_PRIORITY * 2)).toBe(1);
    });

    it('should return 0 for negative priority', () => {
      expect(calculatePriorityScore(-5)).toBe(0);
    });

    it('should use custom max priority', () => {
      expect(calculatePriorityScore(25, 50)).toBe(0.5);
    });
  });

  describe('estimateWaitTime', () => {
    const createWorker = (activeTasks: number): WorkerState => ({
      id: 'worker-1',
      status: 'idle',
      capabilities: [],
      currentLoad: 0,
      lastHeartbeat: new Date(),
      activeTasks,
      maxConcurrency: 10,
    });

    it('should return 0 for idle worker', () => {
      const worker = createWorker(0);
      const prediction: TaskPrediction = {
        taskId: 'task-1',
        recommendedWorkerId: '',
        confidence: 0.8,
        estimatedDurationMs: 1000,
      };

      expect(estimateWaitTime(worker, prediction)).toBe(0);
    });

    it('should multiply active tasks by predicted duration', () => {
      const worker = createWorker(3);
      const prediction: TaskPrediction = {
        taskId: 'task-1',
        recommendedWorkerId: '',
        confidence: 0.8,
        estimatedDurationMs: 2000,
      };

      expect(estimateWaitTime(worker, prediction)).toBe(6000);
    });

    it('should use default duration when prediction is null', () => {
      const worker = createWorker(2);
      expect(estimateWaitTime(worker, null)).toBe(10000); // 2 * 5000 default
    });
  });

  describe('isWorkerEligible', () => {
    const createWorker = (overrides: Partial<WorkerState> = {}): WorkerState => ({
      id: 'worker-1',
      status: 'idle',
      capabilities: ['cpu', 'gpu'],
      currentLoad: 0,
      lastHeartbeat: new Date(),
      activeTasks: 0,
      maxConcurrency: 10,
      ...overrides,
    });

    it('should return true for idle worker', () => {
      expect(isWorkerEligible(createWorker())).toBe(true);
    });

    it('should return true for busy worker with capacity', () => {
      expect(isWorkerEligible(createWorker({ status: 'busy', activeTasks: 5 }))).toBe(true);
    });

    it('should return false for offline worker', () => {
      expect(isWorkerEligible(createWorker({ status: 'offline' }))).toBe(false);
    });

    it('should return false for draining worker', () => {
      expect(isWorkerEligible(createWorker({ status: 'draining' }))).toBe(false);
    });

    it('should return false for worker at max capacity', () => {
      expect(isWorkerEligible(createWorker({ activeTasks: 10 }))).toBe(false);
    });

    it('should check required capabilities', () => {
      const worker = createWorker({ capabilities: ['cpu', 'gpu'] });
      expect(isWorkerEligible(worker, ['cpu'])).toBe(true);
      expect(isWorkerEligible(worker, ['cpu', 'gpu'])).toBe(true);
      expect(isWorkerEligible(worker, ['tpu'])).toBe(false);
    });

    it('should require all capabilities', () => {
      const worker = createWorker({ capabilities: ['cpu'] });
      expect(isWorkerEligible(worker, ['cpu', 'gpu'])).toBe(false);
    });

    it('should pass when no capabilities required', () => {
      const worker = createWorker({ capabilities: [] });
      expect(isWorkerEligible(worker)).toBe(true);
      expect(isWorkerEligible(worker, [])).toBe(true);
    });
  });
});
