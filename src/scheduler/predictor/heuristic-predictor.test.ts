/**
 * Tests for HeuristicPredictor
 */

import { HeuristicPredictor } from './heuristic-predictor';
import { Task } from '../interfaces/types';

// Mock redis client
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  })),
}));

describe('HeuristicPredictor', () => {
  let predictor: HeuristicPredictor;

  beforeEach(async () => {
    predictor = new HeuristicPredictor({
      redisUrl: 'redis://localhost:6379',
      alpha: 0.3,
      defaultDurationMs: 5000,
      confidenceThreshold: 100,
    });
    await predictor.initialize();
  });

  afterEach(async () => {
    await predictor.shutdown();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const newPredictor = new HeuristicPredictor({
        redisUrl: 'redis://localhost:6379',
      });

      await newPredictor.initialize();
      expect(await newPredictor.isReady()).toBe(true);
      await newPredictor.shutdown();
    });

    it('should report not ready before initialization', async () => {
      const newPredictor = new HeuristicPredictor({
        redisUrl: 'redis://localhost:6379',
      });

      expect(await newPredictor.isReady()).toBe(false);
    });
  });

  describe('predict', () => {
    it('should return default duration for unknown task type', async () => {
      const task: Task = {
        id: 'task-1',
        type: 'unknown-type',
        payload: {},
        priority: 1,
        createdAt: new Date(),
      };

      const prediction = await predictor.predict(task);

      expect(prediction).not.toBeNull();
      expect(prediction!.estimatedDurationMs).toBe(5000); // default
      expect(prediction!.confidence).toBe(0); // no samples
      expect(prediction!.taskId).toBe('task-1');
    });

    it('should return learned duration after feedback', async () => {
      // Provide feedback to learn task duration
      await predictor.feedback('task-1', 'worker-1', true, 2000, 'fast-task');
      await predictor.feedback('task-2', 'worker-1', true, 2100, 'fast-task');
      await predictor.feedback('task-3', 'worker-1', true, 1900, 'fast-task');

      const task: Task = {
        id: 'task-4',
        type: 'fast-task',
        payload: {},
        priority: 1,
        createdAt: new Date(),
      };

      const prediction = await predictor.predict(task);

      expect(prediction).not.toBeNull();
      // Should be close to 2000ms range (EMA of ~2000)
      expect(prediction!.estimatedDurationMs).toBeGreaterThan(1500);
      expect(prediction!.estimatedDurationMs).toBeLessThan(2500);
      expect(prediction!.confidence).toBe(0.03); // 3/100
    });

    it('should increase confidence with more samples', async () => {
      // Add 50 samples
      for (let i = 0; i < 50; i++) {
        await predictor.feedback(`task-${i}`, 'worker-1', true, 1000, 'consistent-task');
      }

      const task: Task = {
        id: 'task-test',
        type: 'consistent-task',
        payload: {},
        priority: 1,
        createdAt: new Date(),
      };

      const prediction = await predictor.predict(task);

      expect(prediction!.confidence).toBe(0.5); // 50/100
    });
  });

  describe('feedback', () => {
    it('should ignore feedback without task type', async () => {
      // This should not throw
      await predictor.feedback('task-1', 'worker-1', true, 1000);

      // No predictions should be created
      const stats = predictor.getStats();
      expect(stats.taskTypes).toBe(0);
    });

    it('should update EMA with actual duration', async () => {
      // First observation
      await predictor.feedback('task-1', 'worker-1', true, 1000, 'test-type');
      let prediction = predictor.getPrediction('test-type');
      expect(prediction.estimatedDurationMs).toBe(1000);

      // Second observation with alpha=0.3
      // EMA = 0.3 * 2000 + 0.7 * 1000 = 1300
      await predictor.feedback('task-2', 'worker-1', true, 2000, 'test-type');
      prediction = predictor.getPrediction('test-type');
      expect(prediction.estimatedDurationMs).toBe(1300);
    });

    it('should track multiple task types independently', async () => {
      await predictor.feedback('task-1', 'worker-1', true, 1000, 'type-a');
      await predictor.feedback('task-2', 'worker-1', true, 5000, 'type-b');

      const predictionA = predictor.getPrediction('type-a');
      const predictionB = predictor.getPrediction('type-b');

      expect(predictionA.estimatedDurationMs).toBe(1000);
      expect(predictionB.estimatedDurationMs).toBe(5000);
    });
  });

  describe('getPrediction', () => {
    it('should return default for unknown type', () => {
      const prediction = predictor.getPrediction('nonexistent');

      expect(prediction.estimatedDurationMs).toBe(5000);
      expect(prediction.confidence).toBe(0);
    });

    it('should return learned values for known type', async () => {
      await predictor.feedback('task-1', 'worker-1', true, 3000, 'known-type');

      const prediction = predictor.getPrediction('known-type');

      expect(prediction.estimatedDurationMs).toBe(3000);
      expect(prediction.confidence).toBe(0.01); // 1/100
    });
  });

  describe('getAllPredictions', () => {
    it('should return empty map initially', () => {
      const all = predictor.getAllPredictions();
      expect(all.size).toBe(0);
    });

    it('should return all learned predictions', async () => {
      await predictor.feedback('task-1', 'worker-1', true, 1000, 'type-a');
      await predictor.feedback('task-2', 'worker-1', true, 2000, 'type-b');
      await predictor.feedback('task-3', 'worker-1', true, 3000, 'type-c');

      const all = predictor.getAllPredictions();

      expect(all.size).toBe(3);
      expect(all.has('type-a')).toBe(true);
      expect(all.has('type-b')).toBe(true);
      expect(all.has('type-c')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return zero stats initially', () => {
      const stats = predictor.getStats();

      expect(stats.taskTypes).toBe(0);
      expect(stats.avgConfidence).toBe(0);
      expect(stats.totalSamples).toBe(0);
    });

    it('should calculate stats correctly', async () => {
      // Add samples to two task types
      for (let i = 0; i < 10; i++) {
        await predictor.feedback(`task-a-${i}`, 'worker-1', true, 1000, 'type-a');
      }
      for (let i = 0; i < 20; i++) {
        await predictor.feedback(`task-b-${i}`, 'worker-1', true, 2000, 'type-b');
      }

      const stats = predictor.getStats();

      expect(stats.taskTypes).toBe(2);
      expect(stats.totalSamples).toBe(30);
      // Confidence: (10/100 + 20/100) / 2 = 0.15
      expect(stats.avgConfidence).toBeCloseTo(0.15, 2);
    });
  });

  describe('resetPrediction', () => {
    it('should reset single task type', async () => {
      await predictor.feedback('task-1', 'worker-1', true, 1000, 'type-a');
      await predictor.feedback('task-2', 'worker-1', true, 2000, 'type-b');

      const result = predictor.resetPrediction('type-a');

      expect(result).toBe(true);
      expect(predictor.getAllPredictions().has('type-a')).toBe(false);
      expect(predictor.getAllPredictions().has('type-b')).toBe(true);
    });

    it('should return false for nonexistent type', () => {
      const result = predictor.resetPrediction('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('resetAll', () => {
    it('should reset all predictions', async () => {
      await predictor.feedback('task-1', 'worker-1', true, 1000, 'type-a');
      await predictor.feedback('task-2', 'worker-1', true, 2000, 'type-b');

      predictor.resetAll();

      expect(predictor.getAllPredictions().size).toBe(0);
      expect(predictor.getStats().taskTypes).toBe(0);
    });
  });

  describe('configuration', () => {
    it('should use custom alpha', async () => {
      const customPredictor = new HeuristicPredictor({
        redisUrl: 'redis://localhost:6379',
        alpha: 0.5, // Higher alpha = more weight on recent
      });
      await customPredictor.initialize();

      await customPredictor.feedback('task-1', 'worker-1', true, 1000, 'test');
      await customPredictor.feedback('task-2', 'worker-1', true, 2000, 'test');

      // With alpha=0.5: EMA = 0.5 * 2000 + 0.5 * 1000 = 1500
      const prediction = customPredictor.getPrediction('test');
      expect(prediction.estimatedDurationMs).toBe(1500);

      await customPredictor.shutdown();
    });

    it('should use custom default duration', async () => {
      const customPredictor = new HeuristicPredictor({
        redisUrl: 'redis://localhost:6379',
        defaultDurationMs: 10000,
      });
      await customPredictor.initialize();

      const prediction = customPredictor.getPrediction('unknown');
      expect(prediction.estimatedDurationMs).toBe(10000);

      await customPredictor.shutdown();
    });

    it('should use custom confidence threshold', async () => {
      const customPredictor = new HeuristicPredictor({
        redisUrl: 'redis://localhost:6379',
        confidenceThreshold: 10, // Only need 10 samples for full confidence
      });
      await customPredictor.initialize();

      for (let i = 0; i < 10; i++) {
        await customPredictor.feedback(`task-${i}`, 'worker-1', true, 1000, 'test');
      }

      const prediction = customPredictor.getPrediction('test');
      expect(prediction.confidence).toBe(1.0); // 10/10

      await customPredictor.shutdown();
    });
  });

  describe('performance', () => {
    it('predict() should be fast (< 1ms)', async () => {
      // Pre-populate with data
      for (let i = 0; i < 100; i++) {
        await predictor.feedback(`task-${i}`, 'worker-1', true, 1000 + i, `type-${i % 10}`);
      }

      const task: Task = {
        id: 'perf-test',
        type: 'type-5',
        payload: {},
        priority: 1,
        createdAt: new Date(),
      };

      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        await predictor.predict(task);
      }

      const elapsed = performance.now() - start;
      const avgMs = elapsed / iterations;

      expect(avgMs).toBeLessThan(1);
    });
  });
});
