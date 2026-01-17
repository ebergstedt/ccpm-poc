/**
 * Exponential Moving Average (EMA) calculation utilities
 */

/**
 * EMA state for a single task type
 */
export interface EMAState {
  taskType: string;
  ema: number;
  sampleCount: number;
  lastUpdated: Date;
}

/**
 * Update EMA with a new observation
 * newEMA = α * actual + (1-α) * previousEMA
 *
 * @param current - Current EMA value
 * @param actual - Actual observed value
 * @param alpha - Smoothing factor (0-1), higher = more weight on recent
 * @returns Updated EMA value
 */
export function updateEMA(current: number, actual: number, alpha: number): number {
  return alpha * actual + (1 - alpha) * current;
}

/**
 * Calculate confidence score based on sample count
 * Confidence increases with samples, caps at 1.0
 *
 * @param sampleCount - Number of samples seen
 * @param threshold - Samples needed for full confidence (default: 100)
 * @returns Confidence score between 0 and 1
 */
export function calculateConfidence(sampleCount: number, threshold: number = 100): number {
  return Math.min(1.0, sampleCount / threshold);
}

/**
 * Initialize EMA state for a new task type
 *
 * @param taskType - Task type identifier
 * @param initialValue - Initial EMA value (default estimate)
 * @returns New EMA state
 */
export function initializeEMA(taskType: string, initialValue: number): EMAState {
  return {
    taskType,
    ema: initialValue,
    sampleCount: 0,
    lastUpdated: new Date(),
  };
}

/**
 * Create an updated EMA state with a new observation
 *
 * @param state - Current EMA state
 * @param actual - Actual observed duration
 * @param alpha - Smoothing factor
 * @returns Updated EMA state
 */
export function updateEMAState(state: EMAState, actual: number, alpha: number): EMAState {
  return {
    ...state,
    ema: state.sampleCount === 0 ? actual : updateEMA(state.ema, actual, alpha),
    sampleCount: state.sampleCount + 1,
    lastUpdated: new Date(),
  };
}
