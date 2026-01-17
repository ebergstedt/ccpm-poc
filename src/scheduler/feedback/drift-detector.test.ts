/**
 * Tests for drift detection
 */

import {
  detectDrift,
  calculateDeviation,
  isWithinThreshold,
} from './drift-detector';

describe('Drift Detector', () => {
  describe('detectDrift', () => {
    it('should not detect drift for accurate predictions', () => {
      const result = detectDrift(1000, 1000);
      expect(result.isDrift).toBe(false);
      expect(result.severity).toBe('none');
    });

    it('should not detect drift within thresholds', () => {
      // 50% deviation (ratio = 1.5) is within [0.5, 2.0]
      expect(detectDrift(1000, 1500).isDrift).toBe(false);
      expect(detectDrift(1000, 500).isDrift).toBe(false);
    });

    it('should detect drift for underprediction', () => {
      // Actual > 2x predicted
      const result = detectDrift(1000, 2500);
      expect(result.isDrift).toBe(true);
      expect(result.ratio).toBe(2.5);
      expect(result.message).toContain('Underprediction');
    });

    it('should detect drift for overprediction', () => {
      // Actual < 0.5x predicted
      const result = detectDrift(1000, 400);
      expect(result.isDrift).toBe(true);
      expect(result.ratio).toBe(0.4);
      expect(result.message).toContain('Overprediction');
    });

    it('should classify minor drift', () => {
      // 2.5x deviation is minor (< 3x)
      const result = detectDrift(1000, 2500);
      expect(result.severity).toBe('minor');
    });

    it('should classify major drift', () => {
      // > 3x deviation is major
      const result = detectDrift(1000, 4000);
      expect(result.severity).toBe('major');
    });

    it('should handle zero prediction as major drift', () => {
      const result = detectDrift(0, 1000);
      expect(result.isDrift).toBe(true);
      expect(result.severity).toBe('major');
    });

    it('should handle negative prediction as major drift', () => {
      const result = detectDrift(-100, 1000);
      expect(result.isDrift).toBe(true);
      expect(result.severity).toBe('major');
    });

    it('should use custom thresholds', () => {
      const config = { lowerThreshold: 0.8, upperThreshold: 1.2 };

      // 70% of predicted would be within default but not custom
      const result = detectDrift(1000, 700, config);
      expect(result.isDrift).toBe(true);
    });

    it('should handle edge cases at exact thresholds', () => {
      // Exactly at boundary (ratio = 0.5)
      expect(detectDrift(1000, 500).isDrift).toBe(false);
      // Exactly at boundary (ratio = 2.0)
      expect(detectDrift(1000, 2000).isDrift).toBe(false);
      // Just outside
      expect(detectDrift(1000, 499).isDrift).toBe(true);
      expect(detectDrift(1000, 2001).isDrift).toBe(true);
    });
  });

  describe('calculateDeviation', () => {
    it('should return 0 for exact match', () => {
      expect(calculateDeviation(1000, 1000)).toBe(0);
    });

    it('should calculate deviation correctly', () => {
      expect(calculateDeviation(1000, 1250)).toBe(0.25);
      expect(calculateDeviation(1000, 750)).toBe(0.25);
    });

    it('should handle zero prediction', () => {
      expect(calculateDeviation(0, 0)).toBe(0);
      expect(calculateDeviation(0, 100)).toBe(1);
    });

    it('should return positive values', () => {
      expect(calculateDeviation(1000, 500)).toBeGreaterThanOrEqual(0);
      expect(calculateDeviation(500, 1000)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isWithinThreshold', () => {
    it('should return true for exact match', () => {
      expect(isWithinThreshold(1000, 1000)).toBe(true);
    });

    it('should return true within 25% (default threshold)', () => {
      expect(isWithinThreshold(1000, 1250)).toBe(true);
      expect(isWithinThreshold(1000, 750)).toBe(true);
    });

    it('should return false outside 25%', () => {
      expect(isWithinThreshold(1000, 1300)).toBe(false);
      expect(isWithinThreshold(1000, 700)).toBe(false);
    });

    it('should use custom threshold', () => {
      expect(isWithinThreshold(1000, 1100, 0.1)).toBe(true);
      expect(isWithinThreshold(1000, 1150, 0.1)).toBe(false);
    });
  });
});
