/**
 * Scheduler API Module
 *
 * Provides REST API endpoints for scheduler status, configuration, and controls.
 */

import express, { Application, json } from 'express';
import { WorkerRegistry } from '../registry/worker-registry';
import { Dispatcher } from '../dispatcher/dispatcher';
import { Predictor } from '../interfaces/predictor';
import { SchedulerConfig } from '../interfaces/types';
import { SchedulerHandlers } from './handlers';
import { createSchedulerRoutes, SCHEDULER_BASE_PATH, ApiRoutesConfig } from './routes';
import { errorHandler } from './middleware';

// Re-export types and utilities
export { SchedulerHandlers } from './handlers';
export type {
  SchedulerStatusResponse,
  WorkerListResponse,
  PredictionStateResponse,
  ConfigUpdateRequest,
  OverrideRequest,
  OverrideResponse,
} from './handlers';
export { createSchedulerRoutes, SCHEDULER_BASE_PATH } from './routes';
export type { ApiRoutesConfig } from './routes';
export {
  apiKeyAuth,
  createRateLimiter,
  correlationId,
  requestLogger,
  errorHandler,
} from './middleware';

/**
 * API Server configuration
 */
export interface ApiServerConfig {
  port: number;
  apiKeys: string[];
  enableRateLimiting?: boolean;
  enableLogging?: boolean;
}

/**
 * Creates a standalone Express application with scheduler API
 *
 * @param registry - The WorkerRegistry instance
 * @param dispatcher - The Dispatcher instance
 * @param predictor - The Predictor instance
 * @param schedulerConfig - The SchedulerConfig instance
 * @param apiConfig - API server configuration
 * @returns Configured Express application
 */
export function createApiServer(
  registry: WorkerRegistry,
  dispatcher: Dispatcher,
  predictor: Predictor,
  schedulerConfig: SchedulerConfig,
  apiConfig: ApiServerConfig
): Application {
  const app = express();

  // Parse JSON request bodies
  app.use(json());

  // Create handlers
  const handlers = new SchedulerHandlers(
    registry,
    dispatcher,
    predictor,
    schedulerConfig
  );

  // Create routes
  const routesConfig: ApiRoutesConfig = {
    apiKeys: apiConfig.apiKeys,
    enableRateLimiting: apiConfig.enableRateLimiting,
    enableLogging: apiConfig.enableLogging,
  };

  const schedulerRoutes = createSchedulerRoutes(handlers, routesConfig);

  // Mount routes
  app.use(SCHEDULER_BASE_PATH, schedulerRoutes);

  // Health check endpoint (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}

/**
 * Starts the API server
 *
 * @param app - The Express application
 * @param port - Port to listen on
 * @returns HTTP server instance
 */
export function startApiServer(
  app: Application,
  port: number
): ReturnType<Application['listen']> {
  return app.listen(port, () => {
    console.log(`Scheduler API server listening on port ${port}`);
    console.log(`Endpoints available at http://localhost:${port}${SCHEDULER_BASE_PATH}`);
  });
}
