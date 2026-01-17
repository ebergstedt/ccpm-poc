/**
 * Drift Detector - Detects when predictions deviate significantly from actual values
 */

/**
 * Drift detection configuration
 */
export interface DriftConfig {
  lowerThreshold: number; // Ratio below which is drift (default: 0.5)
  upperThreshold: number; // Ratio above which is drift (default: 2.0)
}

/**
 * Default drift configuration
 * Drift is detected when actual/predicted ratio is outside [0.5, 2.0]
 */
export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  lowerThreshold: 0.5,
  upperThreshold: 2.0,
};

/**
 * Drift detection result
 */
export interface DriftResult {
  isDrift: boolean;
  ratio: number;
  severity: 'none' | 'minor' | 'major';
  message: string;
}

/**
 * Detect drift between predicted and actual values
 *
 * @param predicted - Predicted duration in ms
 * @param actual - Actual duration in ms
 * @param config - Drift thresholds
 * @returns Drift detection result
 */
export function detectDrift(
  predicted: number,
  actual: number,
  config: DriftConfig = DEFAULT_DRIFT_CONFIG
): DriftResult {
  // Handle edge cases
  if (predicted <= 0) {
    return {
      isDrift: true,
      ratio: Infinity,
      severity: 'major',
      message: 'Invalid prediction (zero or negative)',
    };
  }

  const ratio = actual / predicted;
  const isDrift = ratio < config.lowerThreshold || ratio > config.upperThreshold;

  // Determine severity
  let severity: DriftResult['severity'] = 'none';
  if (isDrift) {
    // Major: more than 3x deviation
    if (ratio < 0.33 || ratio > 3.0) {
      severity = 'major';
    } else {
      severity = 'minor';
    }
  }

  // Generate message
  let message: string;
  if (!isDrift) {
    message = `Prediction accurate (ratio=${ratio.toFixed(2)})`;
  } else if (actual > predicted) {
    message = `Underprediction: actual ${actual}ms >> predicted ${predicted}ms (ratio=${ratio.toFixed(2)})`;
  } else {
    message = `Overprediction: actual ${actual}ms << predicted ${predicted}ms (ratio=${ratio.toFixed(2)})`;
  }

  return {
    isDrift,
    ratio,
    severity,
    message,
  };
}

/**
 * Calculate deviation percentage between predicted and actual
 *
 * @param predicted - Predicted value
 * @param actual - Actual value
 * @returns Deviation as percentage (e.g., 0.25 = 25%)
 */
export function calculateDeviation(predicted: number, actual: number): number {
  if (predicted === 0) return actual === 0 ? 0 : 1;
  return Math.abs(actual - predicted) / predicted;
}

/**
 * Check if prediction is within acceptable threshold
 *
 * @param predicted - Predicted value
 * @param actual - Actual value
 * @param threshold - Acceptable deviation (default: 0.25 = 25%)
 * @returns Whether prediction is within threshold
 */
export function isWithinThreshold(
  predicted: number,
  actual: number,
  threshold: number = 0.25
): boolean {
  const deviation = calculateDeviation(predicted, actual);
  return deviation <= threshold;
}
