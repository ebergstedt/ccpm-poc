/**
 * API Routes - Express route definitions for scheduler endpoints
 */

import { Router } from 'express';
import { SchedulerHandlers } from './handlers';
import {
  apiKeyAuth,
  createRateLimiter,
  correlationId,
  requestLogger,
} from './middleware';

/**
 * API configuration options
 */
export interface ApiRoutesConfig {
  apiKeys: string[];
  enableRateLimiting?: boolean;
  enableLogging?: boolean;
}

/**
 * Creates and configures the scheduler API router
 *
 * @param handlers - The SchedulerHandlers instance
 * @param config - API configuration options
 * @returns Configured Express router
 */
export function createSchedulerRoutes(
  handlers: SchedulerHandlers,
  config: ApiRoutesConfig
): Router {
  const router = Router();

  // Create API key set for validation
  const validApiKeys = new Set(config.apiKeys);

  // Apply common middleware to all routes
  router.use(correlationId);

  if (config.enableLogging !== false) {
    router.use(requestLogger);
  }

  if (config.enableRateLimiting !== false) {
    router.use(createRateLimiter());
  }

  // Apply authentication to all routes
  router.use(apiKeyAuth(validApiKeys));

  /**
   * GET /scheduler/status
   * Returns overall scheduler health and statistics
   */
  router.get('/status', handlers.getStatus);

  /**
   * GET /scheduler/workers
   * Returns list of workers with current state
   */
  router.get('/workers', handlers.getWorkers);

  /**
   * GET /scheduler/predictions
   * Returns current prediction states
   */
  router.get('/predictions', handlers.getPredictions);

  /**
   * PUT /scheduler/config
   * Updates runtime configuration
   */
  router.put('/config', handlers.updateConfig);

  /**
   * POST /scheduler/override
   * Manually selects a worker for a task
   */
  router.post('/override', handlers.override);

  /**
   * DELETE /scheduler/predictions/:taskType
   * Resets predictions for a specific task type
   */
  router.delete('/predictions/:taskType', handlers.resetPredictions);

  return router;
}

/**
 * Get the base path for scheduler routes
 */
export const SCHEDULER_BASE_PATH = '/scheduler';
