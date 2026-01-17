/**
 * Unit tests for AvailabilityCalculator
 */

import {
  AvailabilityCalculator,
  calculateCurrentLoad,
  calculateEstimatedAvailableAt,
  determineHealthStatus,
  isSignificantLoadChange,
  LOAD_WEIGHTS,
  HEALTH_THRESHOLDS,
  DEFAULT_AVG_TASK_DURATION_MS,
} from './availability-calculator';
import { WorkerHeartbeat } from '../interfaces/types';

describe('AvailabilityCalculator', () => {
  describe('calculateCurrentLoad', () => {
    it('should calculate load with correct weights', () => {
      // 0.6 * 0.5 + 0.4 * 0.5 = 0.5
      expect(calculateCurrentLoad(0.5, 0.5)).toBe(0.5);

      // 0.6 * 1.0 + 0.4 * 0.0 = 0.6
      expect(calculateCurrentLoad(1.0, 0.0)).toBe(0.6);

      // 0.6 * 0.0 + 0.4 * 1.0 = 0.4
      expect(calculateCurrentLoad(0.0, 1.0)).toBe(0.4);

      // 0.6 * 1.0 + 0.4 * 1.0 = 1.0
      expect(calculateCurrentLoad(1.0, 1.0)).toBe(1.0);

      // 0.6 * 0.0 + 0.4 * 0.0 = 0.0
      expect(calculateCurrentLoad(0.0, 0.0)).toBe(0.0);
    });

    it('should clamp values between 0 and 1', () => {
      // Values over 1 should be clamped
      expect(calculateCurrentLoad(1.5, 0.5)).toBe(
        LOAD_WEIGHTS.CPU * 1 + LOAD_WEIGHTS.MEMORY * 0.5
      );

      // Negative values should be clamped to 0
      expect(calculateCurrentLoad(-0.5, 0.5)).toBe(
        LOAD_WEIGHTS.CPU * 0 + LOAD_WEIGHTS.MEMORY * 0.5
      );
    });
  });

  describe('calculateEstimatedAvailableAt', () => {
    it('should calculate estimated availability based on queue depth', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const avgDuration = 1000; // 1 second

      // Queue depth 0 = available now
      const immediate = calculateEstimatedAvailableAt(0, avgDuration, now);
      expect(immediate.getTime()).toBe(now.getTime());

      // Queue depth 5 with 1s avg = 5 seconds from now
      const fiveSeconds = calculateEstimatedAvailableAt(5, avgDuration, now);
      expect(fiveSeconds.getTime()).toBe(now.getTime() + 5000);

      // Queue depth 10 with 2s avg = 20 seconds from now
      const twentySeconds = calculateEstimatedAvailableAt(10, 2000, now);
      expect(twentySeconds.getTime()).toBe(now.getTime() + 20000);
    });

    it('should use default duration if not provided', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const result = calculateEstimatedAvailableAt(2, undefined, now);
      expect(result.getTime()).toBe(now.getTime() + 2 * DEFAULT_AVG_TASK_DURATION_MS);
    });
  });

  describe('determineHealthStatus', () => {
    it('should return healthy when heartbeat is recent and load is low', () => {
      const now = new Date();
      const recentHeartbeat = now.getTime() - 5000; // 5 seconds ago
      expect(determineHealthStatus(recentHeartbeat, 0.5, now)).toBe('healthy');
    });

    it('should return degraded when load is high but heartbeat is recent', () => {
      const now = new Date();
      const recentHeartbeat = now.getTime() - 5000; // 5 seconds ago
      expect(determineHealthStatus(recentHeartbeat, 0.9, now)).toBe('degraded');
      expect(determineHealthStatus(recentHeartbeat, 0.95, now)).toBe('degraded');
      expect(determineHealthStatus(recentHeartbeat, 1.0, now)).toBe('degraded');
    });

    it('should return unhealthy when heartbeat is stale (30s)', () => {
      const now = new Date();
      const staleHeartbeat = now.getTime() - 35000; // 35 seconds ago
      expect(determineHealthStatus(staleHeartbeat, 0.5, now)).toBe('unhealthy');
    });

    it('should return removed when heartbeat is very stale (5 minutes)', () => {
      const now = new Date();
      const veryStaleHeartbeat = now.getTime() - 310000; // 5+ minutes ago
      expect(determineHealthStatus(veryStaleHeartbeat, 0.5, now)).toBe('removed');
    });

    it('should check thresholds in correct order', () => {
      const now = new Date();

      // At exactly 30 seconds - should be unhealthy
      const exactly30s = now.getTime() - HEALTH_THRESHOLDS.UNHEALTHY_TIMEOUT_MS;
      expect(determineHealthStatus(exactly30s, 0.5, now)).toBe('unhealthy');

      // At exactly 5 minutes - should be removed
      const exactly5min = now.getTime() - HEALTH_THRESHOLDS.REMOVED_TIMEOUT_MS;
      expect(determineHealthStatus(exactly5min, 0.5, now)).toBe('removed');
    });
  });

  describe('isSignificantLoadChange', () => {
    it('should return true when load changes by more than threshold', () => {
      expect(isSignificantLoadChange(0.5, 0.61, 0.1)).toBe(true);
      expect(isSignificantLoadChange(0.5, 0.39, 0.1)).toBe(true);
    });

    it('should return false when load changes by less than threshold', () => {
      expect(isSignificantLoadChange(0.5, 0.55, 0.1)).toBe(false);
      expect(isSignificantLoadChange(0.5, 0.45, 0.1)).toBe(false);
    });

    it('should return true when load changes at or above threshold', () => {
      // Just above threshold
      expect(isSignificantLoadChange(0.5, 0.61, 0.1)).toBe(true);
      expect(isSignificantLoadChange(0.5, 0.39, 0.1)).toBe(true);
    });

    it('should use default threshold of 0.1', () => {
      expect(isSignificantLoadChange(0.5, 0.61)).toBe(true);
      expect(isSignificantLoadChange(0.5, 0.55)).toBe(false);
    });
  });

  describe('AvailabilityCalculator class', () => {
    let calculator: AvailabilityCalculator;

    beforeEach(() => {
      calculator = new AvailabilityCalculator(5000); // 5 second avg duration
    });

    describe('processHeartbeat', () => {
      it('should process heartbeat and return capacity state', () => {
        const heartbeat: WorkerHeartbeat = {
          workerId: 'worker-1',
          cpuUsage: 0.5,
          memoryUsage: 0.5,
          queueDepth: 3,
          timestampMs: Date.now(),
        };

        const result = calculator.processHeartbeat(heartbeat);

        expect(result.queueDepth).toBe(3);
        expect(result.healthStatus).toBe('healthy');
        expect(result.avgTaskDurationMs).toBe(5000);
        expect(result.estimatedAvailableAt).toBeDefined();
      });

      it('should mark as degraded when load is high', () => {
        const heartbeat: WorkerHeartbeat = {
          workerId: 'worker-1',
          cpuUsage: 0.95,
          memoryUsage: 0.9,
          queueDepth: 0,
          timestampMs: Date.now(),
        };

        const result = calculator.processHeartbeat(heartbeat);
        expect(result.healthStatus).toBe('degraded');
      });
    });

    describe('shouldMarkUnhealthy', () => {
      it('should return true when heartbeat is older than 30 seconds', () => {
        const now = new Date();
        const staleHeartbeat = now.getTime() - 35000;
        expect(calculator.shouldMarkUnhealthy(staleHeartbeat, now)).toBe(true);
      });

      it('should return false when heartbeat is recent', () => {
        const now = new Date();
        const recentHeartbeat = now.getTime() - 10000;
        expect(calculator.shouldMarkUnhealthy(recentHeartbeat, now)).toBe(false);
      });
    });

    describe('shouldRemoveWorker', () => {
      it('should return true when heartbeat is older than 5 minutes', () => {
        const now = new Date();
        const veryStaleHeartbeat = now.getTime() - 310000;
        expect(calculator.shouldRemoveWorker(veryStaleHeartbeat, now)).toBe(true);
      });

      it('should return false when heartbeat is within 5 minutes', () => {
        const now = new Date();
        const recentHeartbeat = now.getTime() - 60000;
        expect(calculator.shouldRemoveWorker(recentHeartbeat, now)).toBe(false);
      });
    });

    describe('updateAvgTaskDuration', () => {
      it('should update average using exponential moving average', () => {
        calculator = new AvailabilityCalculator(5000);
        const initial = calculator.getAvgTaskDuration();

        // Update with a much larger value
        calculator.updateAvgTaskDuration(15000);

        const updated = calculator.getAvgTaskDuration();
        // Should be between initial and new value (exponential average)
        expect(updated).toBeGreaterThan(initial);
        expect(updated).toBeLessThan(15000);
      });

      it('should gradually converge to new values', () => {
        calculator = new AvailabilityCalculator(5000);

        // Apply same update multiple times
        for (let i = 0; i < 20; i++) {
          calculator.updateAvgTaskDuration(10000);
        }

        const avg = calculator.getAvgTaskDuration();
        // Should be close to 10000 after many updates
        expect(avg).toBeGreaterThan(9000);
      });
    });
  });
});
