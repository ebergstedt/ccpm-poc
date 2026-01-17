/**
 * Tests for MultiObjectiveScorer
 */

import {
  MultiObjectiveScorer,
  DEFAULT_SCORER_CONFIG,
  DEFAULT_SCORING_WEIGHTS,
} from './scorer';
import { Task, WorkerState, TaskPrediction } from '../interfaces/types';

describe('MultiObjectiveScorer', () => {
  let scorer: MultiObjectiveScorer;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    type: 'default',
    payload: {},
    priority: 5,
    createdAt: new Date(),
    ...overrides,
  });

  const createWorker = (id: string, overrides: Partial<WorkerState> = {}): WorkerState => ({
    id,
    status: 'idle',
    capabilities: [],
    currentLoad: 0,
    lastHeartbeat: new Date(),
    activeTasks: 0,
    maxConcurrency: 10,
    ...overrides,
  });

  const createPrediction = (overrides: Partial<TaskPrediction> = {}): TaskPrediction => ({
    taskId: 'task-1',
    recommendedWorkerId: '',
    confidence: 0.8,
    estimatedDurationMs: 2000,
    ...overrides,
  });

  beforeEach(() => {
    scorer = new MultiObjectiveScorer();
  });

  describe('constructor', () => {
    it('should use default config', () => {
      const config = scorer.getConfig();
      expect(config).toEqual(DEFAULT_SCORER_CONFIG);
    });

    it('should allow custom weights', () => {
      scorer = new MultiObjectiveScorer({
        weights: { wait: 0.5, load: 0.3, priority: 0.2 },
      });
      const config = scorer.getConfig();
      expect(config.weights.wait).toBe(0.5);
      expect(config.weights.load).toBe(0.3);
    });

    it('should merge partial weights with defaults', () => {
      scorer = new MultiObjectiveScorer({
        weights: { wait: 0.6 },
      });
      const config = scorer.getConfig();
      expect(config.weights.wait).toBe(0.6);
      expect(config.weights.load).toBe(DEFAULT_SCORING_WEIGHTS.load);
    });
  });

  describe('score', () => {
    it('should return null when no workers available', () => {
      const task = createTask();
      const result = scorer.score(task, [], null);
      expect(result).toBeNull();
    });

    it('should return null when no eligible workers', () => {
      const task = createTask();
      const workers = [
        createWorker('w1', { status: 'offline' }),
        createWorker('w2', { status: 'draining' }),
      ];
      const result = scorer.score(task, workers, null);
      expect(result).toBeNull();
    });

    it('should select the only eligible worker', () => {
      const task = createTask();
      const workers = [createWorker('w1')];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('w1');
      expect(result!.alternatives).toHaveLength(0);
    });

    it('should prefer worker with lower load', () => {
      const task = createTask({ priority: 5 });
      const workers = [
        createWorker('w1', { currentLoad: 0.8 }),
        createWorker('w2', { currentLoad: 0.2 }),
      ];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('w2');
    });

    it('should prefer worker with lower wait time', () => {
      const task = createTask({ priority: 5 });
      const workers = [
        createWorker('w1', { activeTasks: 5 }),
        createWorker('w2', { activeTasks: 1 }),
      ];
      const prediction = createPrediction({ estimatedDurationMs: 2000 });
      const result = scorer.score(task, workers, prediction);

      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('w2');
    });

    it('should include alternatives in result', () => {
      const task = createTask();
      const workers = [
        createWorker('w1', { currentLoad: 0.5 }),
        createWorker('w2', { currentLoad: 0.3 }),
        createWorker('w3', { currentLoad: 0.8 }),
      ];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.alternatives).toHaveLength(2);
    });

    it('should generate reasoning string', () => {
      const task = createTask({ id: 'test-task', priority: 7 });
      const workers = [createWorker('w1')];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.reasoning).toContain('Selected w1');
      expect(result!.reasoning).toContain('test-task');
      expect(result!.reasoning).toContain('priority 7');
    });

    it('should filter by required capabilities', () => {
      const task = createTask({
        metadata: { requiredCapabilities: ['gpu'] },
      });
      const workers = [
        createWorker('w1', { capabilities: ['cpu'] }),
        createWorker('w2', { capabilities: ['cpu', 'gpu'] }),
      ];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('w2');
      expect(result!.alternatives).toHaveLength(0);
    });

    it('should include score breakdown in results', () => {
      const task = createTask({ priority: 5 });
      const workers = [createWorker('w1', { currentLoad: 0.4 })];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
      expect(result!.score).toBeLessThanOrEqual(1);
    });
  });

  describe('scoring formula', () => {
    it('should apply weights correctly', () => {
      // Custom weights heavily favoring load
      scorer = new MultiObjectiveScorer({
        weights: { wait: 0, load: 1, priority: 0 },
      });

      const task = createTask({ priority: 10 });
      const workers = [
        createWorker('w1', { currentLoad: 0.9 }),
        createWorker('w2', { currentLoad: 0.1 }),
      ];

      const result = scorer.score(task, workers, null);
      expect(result!.workerId).toBe('w2');
    });

    it('should balance multiple objectives', () => {
      // Equal weights
      scorer = new MultiObjectiveScorer({
        weights: { wait: 0.33, load: 0.33, priority: 0.34 },
      });

      const task = createTask({ priority: 5 });
      const workers = [
        createWorker('w1', { currentLoad: 0.3, activeTasks: 3 }),
        createWorker('w2', { currentLoad: 0.5, activeTasks: 1 }),
      ];
      const prediction = createPrediction({ estimatedDurationMs: 1000 });

      const result = scorer.score(task, workers, prediction);
      expect(result).not.toBeNull();
      // Result depends on balanced scoring
    });
  });

  describe('updateWeights', () => {
    it('should update weights', () => {
      scorer.updateWeights({ wait: 0.6 });
      const config = scorer.getConfig();
      expect(config.weights.wait).toBe(0.6);
    });

    it('should preserve other weights', () => {
      scorer.updateWeights({ wait: 0.6 });
      const config = scorer.getConfig();
      expect(config.weights.load).toBe(DEFAULT_SCORING_WEIGHTS.load);
    });
  });

  describe('validateWeights', () => {
    it('should return true for valid weights', () => {
      expect(scorer.validateWeights()).toBe(true);
    });

    it('should return false for invalid weights', () => {
      scorer.updateWeights({ wait: 0.5, load: 0.5, priority: 0.5 });
      expect(scorer.validateWeights()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle workers at capacity', () => {
      const task = createTask();
      const workers = [
        createWorker('w1', { activeTasks: 10, maxConcurrency: 10 }),
        createWorker('w2', { activeTasks: 5, maxConcurrency: 10 }),
      ];
      const result = scorer.score(task, workers, null);

      expect(result).not.toBeNull();
      expect(result!.workerId).toBe('w2');
    });

    it('should handle high priority task', () => {
      scorer = new MultiObjectiveScorer({
        weights: { wait: 0, load: 0, priority: 1 },
      });

      const task = createTask({ priority: 10 });
      const workers = [
        createWorker('w1', { currentLoad: 0.1 }),
        createWorker('w2', { currentLoad: 0.9 }),
      ];
      const result = scorer.score(task, workers, null);

      // Both get same priority score, but w1 has lower load as tiebreaker
      expect(result).not.toBeNull();
    });

    it('should handle ties deterministically', () => {
      const task = createTask();
      const workers = [
        createWorker('w1', { currentLoad: 0.5 }),
        createWorker('w2', { currentLoad: 0.5 }),
      ];

      const result1 = scorer.score(task, workers, null);
      const result2 = scorer.score(task, workers, null);

      // Should return consistent results
      expect(result1!.workerId).toBe(result2!.workerId);
    });
  });
});
