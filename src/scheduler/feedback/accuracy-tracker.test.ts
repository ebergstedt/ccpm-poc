/**
 * Tests for AccuracyTracker
 */

import { AccuracyTracker } from './accuracy-tracker';

describe('AccuracyTracker', () => {
  let tracker: AccuracyTracker;

  beforeEach(() => {
    tracker = new AccuracyTracker();
  });

  describe('record', () => {
    it('should record a sample', () => {
      tracker.record('task-type-a', 1000, 1000);
      expect(tracker.getSampleCount()).toBe(1);
    });

    it('should maintain window size', () => {
      tracker = new AccuracyTracker({ windowSize: 5 });

      for (let i = 0; i < 10; i++) {
        tracker.record('type', 1000, 1000 + i * 100);
      }

      expect(tracker.getSampleCount()).toBe(5);
    });

    it('should mark accurate predictions', () => {
      tracker.record('type', 1000, 1000); // exact match
      tracker.record('type', 1000, 1200); // 20% deviation (within 25%)
      tracker.record('type', 1000, 1500); // 50% deviation (outside)

      const stats = tracker.getStats();
      expect(stats.withinThreshold).toBe(2);
      expect(stats.total).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty tracker', () => {
      const stats = tracker.getStats();
      expect(stats.total).toBe(0);
      expect(stats.accuracy).toBe(0);
    });

    it('should calculate accuracy correctly', () => {
      // 4 accurate, 1 inaccurate
      tracker.record('type', 1000, 1000);
      tracker.record('type', 1000, 1100);
      tracker.record('type', 1000, 1200);
      tracker.record('type', 1000, 1250);
      tracker.record('type', 1000, 2000); // 100% deviation

      const stats = tracker.getStats();
      expect(stats.accuracy).toBe(0.8);
    });

    it('should track number of task types', () => {
      tracker.record('type-a', 1000, 1000);
      tracker.record('type-b', 1000, 1000);
      tracker.record('type-a', 1000, 1000);

      const stats = tracker.getStats();
      expect(stats.taskTypes).toBe(2);
    });

    it('should calculate average deviation', () => {
      tracker.record('type', 1000, 1000); // 0% deviation
      tracker.record('type', 1000, 1500); // 50% deviation

      const stats = tracker.getStats();
      expect(stats.avgDeviation).toBeCloseTo(0.25);
    });
  });

  describe('getByTaskType', () => {
    it('should return empty array for no samples', () => {
      expect(tracker.getByTaskType()).toHaveLength(0);
    });

    it('should breakdown by task type', () => {
      tracker.record('type-a', 1000, 1000);
      tracker.record('type-a', 1000, 1100);
      tracker.record('type-b', 1000, 2000);

      const byType = tracker.getByTaskType();
      expect(byType).toHaveLength(2);

      const typeA = byType.find((t) => t.taskType === 'type-a');
      expect(typeA?.total).toBe(2);
      expect(typeA?.accuracy).toBe(1); // both within threshold

      const typeB = byType.find((t) => t.taskType === 'type-b');
      expect(typeB?.total).toBe(1);
      expect(typeB?.accuracy).toBe(0); // outside threshold
    });

    it('should sort by total count descending', () => {
      tracker.record('type-a', 1000, 1000);
      tracker.record('type-b', 1000, 1000);
      tracker.record('type-b', 1000, 1000);
      tracker.record('type-c', 1000, 1000);
      tracker.record('type-c', 1000, 1000);
      tracker.record('type-c', 1000, 1000);

      const byType = tracker.getByTaskType();
      expect(byType[0].taskType).toBe('type-c');
      expect(byType[1].taskType).toBe('type-b');
      expect(byType[2].taskType).toBe('type-a');
    });
  });

  describe('getRecentSamples', () => {
    it('should return recent samples', () => {
      for (let i = 0; i < 20; i++) {
        tracker.record('type', i * 100, i * 100);
      }

      const recent = tracker.getRecentSamples(5);
      expect(recent).toHaveLength(5);
      expect(recent[4].predicted).toBe(1900);
    });

    it('should return all if less than requested', () => {
      tracker.record('type', 1000, 1000);
      tracker.record('type', 2000, 2000);

      const recent = tracker.getRecentSamples(10);
      expect(recent).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('should clear all samples', () => {
      tracker.record('type', 1000, 1000);
      tracker.record('type', 2000, 2000);

      tracker.clear();

      expect(tracker.getSampleCount()).toBe(0);
      expect(tracker.getStats().total).toBe(0);
    });
  });

  describe('isAccuracyBelowTarget', () => {
    it('should return false for empty tracker', () => {
      expect(tracker.isAccuracyBelowTarget()).toBe(false);
    });

    it('should return true when accuracy below target', () => {
      // All inaccurate
      tracker.record('type', 1000, 5000);
      tracker.record('type', 1000, 5000);

      expect(tracker.isAccuracyBelowTarget(0.8)).toBe(true);
    });

    it('should return false when accuracy above target', () => {
      // All accurate
      tracker.record('type', 1000, 1000);
      tracker.record('type', 1000, 1000);

      expect(tracker.isAccuracyBelowTarget(0.8)).toBe(false);
    });

    it('should use custom target', () => {
      // 50% accuracy
      tracker.record('type', 1000, 1000); // accurate
      tracker.record('type', 1000, 5000); // inaccurate

      expect(tracker.isAccuracyBelowTarget(0.6)).toBe(true);
      expect(tracker.isAccuracyBelowTarget(0.4)).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should use custom accuracy threshold', () => {
      tracker = new AccuracyTracker({ accuracyThreshold: 0.1 });

      tracker.record('type', 1000, 1100); // 10% - at threshold
      tracker.record('type', 1000, 1150); // 15% - outside threshold

      const stats = tracker.getStats();
      expect(stats.withinThreshold).toBe(1);
    });
  });
});
