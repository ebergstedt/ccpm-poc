/**
 * Tests for EMA calculation utilities
 */

import {
  updateEMA,
  calculateConfidence,
  initializeEMA,
  updateEMAState,
} from './ema';

describe('EMA utilities', () => {
  describe('updateEMA', () => {
    it('should calculate EMA correctly with alpha 0.3', () => {
      const current = 100;
      const actual = 200;
      const alpha = 0.3;

      // newEMA = 0.3 * 200 + 0.7 * 100 = 60 + 70 = 130
      const result = updateEMA(current, actual, alpha);
      expect(result).toBe(130);
    });

    it('should give more weight to recent with higher alpha', () => {
      const current = 100;
      const actual = 200;

      const lowAlpha = updateEMA(current, actual, 0.1);
      const highAlpha = updateEMA(current, actual, 0.9);

      // Higher alpha means closer to actual value
      expect(highAlpha).toBeGreaterThan(lowAlpha);
      expect(highAlpha).toBeCloseTo(190, 1);
      expect(lowAlpha).toBeCloseTo(110, 1);
    });

    it('should return actual when alpha is 1', () => {
      const result = updateEMA(100, 200, 1.0);
      expect(result).toBe(200);
    });

    it('should return current when alpha is 0', () => {
      const result = updateEMA(100, 200, 0.0);
      expect(result).toBe(100);
    });

    it('should handle negative values', () => {
      const result = updateEMA(-100, -50, 0.3);
      // -0.3 * 50 + -0.7 * 100 = -15 + -70 = -85
      expect(result).toBe(-85);
    });

    it('should converge over multiple updates', () => {
      let ema = 100;
      const alpha = 0.3;

      // Simulate receiving constant value of 50
      for (let i = 0; i < 20; i++) {
        ema = updateEMA(ema, 50, alpha);
      }

      // Should converge close to 50
      expect(ema).toBeCloseTo(50, 0);
    });
  });

  describe('calculateConfidence', () => {
    it('should return 0 for 0 samples', () => {
      expect(calculateConfidence(0)).toBe(0);
    });

    it('should return 0.5 for 50 samples (default threshold 100)', () => {
      expect(calculateConfidence(50)).toBe(0.5);
    });

    it('should return 1.0 for 100 samples', () => {
      expect(calculateConfidence(100)).toBe(1.0);
    });

    it('should cap at 1.0 for more than 100 samples', () => {
      expect(calculateConfidence(200)).toBe(1.0);
      expect(calculateConfidence(1000)).toBe(1.0);
    });

    it('should respect custom threshold', () => {
      expect(calculateConfidence(50, 50)).toBe(1.0);
      expect(calculateConfidence(25, 50)).toBe(0.5);
      expect(calculateConfidence(100, 200)).toBe(0.5);
    });

    it('should handle very small thresholds', () => {
      expect(calculateConfidence(1, 1)).toBe(1.0);
      expect(calculateConfidence(5, 10)).toBe(0.5);
    });
  });

  describe('initializeEMA', () => {
    it('should create initial state with correct values', () => {
      const state = initializeEMA('task-type-a', 5000);

      expect(state.taskType).toBe('task-type-a');
      expect(state.ema).toBe(5000);
      expect(state.sampleCount).toBe(0);
      expect(state.lastUpdated).toBeInstanceOf(Date);
    });

    it('should create unique state objects', () => {
      const state1 = initializeEMA('type-a', 100);
      const state2 = initializeEMA('type-b', 200);

      expect(state1).not.toBe(state2);
      expect(state1.taskType).not.toBe(state2.taskType);
    });
  });

  describe('updateEMAState', () => {
    it('should use actual value as EMA on first observation', () => {
      const initial = initializeEMA('test', 5000);
      expect(initial.sampleCount).toBe(0);

      const updated = updateEMAState(initial, 3000, 0.3);

      // First observation should just use the actual value
      expect(updated.ema).toBe(3000);
      expect(updated.sampleCount).toBe(1);
    });

    it('should apply EMA formula on subsequent observations', () => {
      let state = initializeEMA('test', 5000);

      // First observation
      state = updateEMAState(state, 1000, 0.3);
      expect(state.ema).toBe(1000);
      expect(state.sampleCount).toBe(1);

      // Second observation: 0.3 * 2000 + 0.7 * 1000 = 600 + 700 = 1300
      state = updateEMAState(state, 2000, 0.3);
      expect(state.ema).toBe(1300);
      expect(state.sampleCount).toBe(2);
    });

    it('should update lastUpdated timestamp', () => {
      const initial = initializeEMA('test', 5000);
      const beforeUpdate = initial.lastUpdated;

      // Small delay to ensure timestamp difference
      const updated = updateEMAState(initial, 3000, 0.3);

      expect(updated.lastUpdated.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
    });

    it('should preserve task type', () => {
      const initial = initializeEMA('my-task-type', 5000);
      const updated = updateEMAState(initial, 3000, 0.3);

      expect(updated.taskType).toBe('my-task-type');
    });

    it('should not mutate original state', () => {
      const initial = initializeEMA('test', 5000);
      const originalEma = initial.ema;
      const originalCount = initial.sampleCount;

      updateEMAState(initial, 3000, 0.3);

      expect(initial.ema).toBe(originalEma);
      expect(initial.sampleCount).toBe(originalCount);
    });

    it('should handle multiple updates correctly', () => {
      let state = initializeEMA('test', 5000);
      const alpha = 0.3;
      const values = [100, 150, 120, 130, 110];

      for (const value of values) {
        state = updateEMAState(state, value, alpha);
      }

      expect(state.sampleCount).toBe(5);
      // EMA should be in reasonable range
      expect(state.ema).toBeGreaterThan(100);
      expect(state.ema).toBeLessThan(150);
    });
  });
});
