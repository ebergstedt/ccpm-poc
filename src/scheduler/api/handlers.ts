/**
 * API Request Handlers - Scheduler status, configuration, and controls
 */

import { Request, Response } from 'express';
import { WorkerRegistry } from '../registry/worker-registry';
import { Dispatcher } from '../dispatcher/dispatcher';
import { Predictor } from '../interfaces/predictor';
import { SchedulerConfig, Task, WorkerState } from '../interfaces/types';

/**
 * Response types for API endpoints
 */
export interface SchedulerStatusResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  workers: {
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
  predictions: {
    taskTypes: number;
    avgConfidence: number;
  };
  decisions: {
    total: number;
    fallbackRate: number;
  };
  latency: {
    p50: number;
    p99: number;
  };
}

export interface WorkerListResponse {
  workers: WorkerState[];
  total: number;
  available: number;
}

export interface PredictionStateResponse {
  taskTypes: string[];
  states: Record<string, {
    avgConfidence: number;
    totalPredictions: number;
    lastUpdated: string;
  }>;
}

export interface ConfigUpdateRequest {
  fallbackThreshold?: number;
  heartbeatTimeoutMs?: number;
}

export interface OverrideRequest {
  taskId: string;
  taskType: string;
  workerId: string;
  payload: Record<string, unknown>;
}

export interface OverrideResponse {
  success: boolean;
  taskId: string;
  workerId: string;
  message: string;
}

/**
 * Scheduler API Handlers
 * Provides handlers for all scheduler REST endpoints
 */
export class SchedulerHandlers {
  private registry: WorkerRegistry;
  private dispatcher: Dispatcher;
  private predictor: Predictor;
  private config: SchedulerConfig;
  private startTime: Date;

  // Metrics tracking
  private predictionStats: Map<string, {
    avgConfidence: number;
    totalPredictions: number;
    lastUpdated: Date;
  }> = new Map();

  private decisionMetrics = {
    total: 0,
    fallbackCount: 0,
    latencies: [] as number[],
  };

  constructor(
    registry: WorkerRegistry,
    dispatcher: Dispatcher,
    predictor: Predictor,
    config: SchedulerConfig
  ) {
    this.registry = registry;
    this.dispatcher = dispatcher;
    this.predictor = predictor;
    this.config = config;
    this.startTime = new Date();
  }

  /**
   * GET /scheduler/status
   * Returns overall scheduler health and statistics
   */
  getStatus = (_req: Request, res: Response): void => {
    const workers = this.registry.getAll();
    const now = new Date();

    // Count workers by health status
    let healthy = 0;
    let degraded = 0;
    let unhealthy = 0;

    for (const worker of workers) {
      const timeSinceHeartbeat = now.getTime() - worker.lastHeartbeat.getTime();

      if (worker.status === 'offline' || timeSinceHeartbeat > this.config.heartbeatTimeoutMs) {
        unhealthy++;
      } else if (worker.status === 'draining' || worker.currentLoad > 0.8) {
        degraded++;
      } else {
        healthy++;
      }
    }

    // Calculate prediction stats
    let avgConfidence = 0;
    if (this.predictionStats.size > 0) {
      const confidences = Array.from(this.predictionStats.values()).map(s => s.avgConfidence);
      avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    }

    // Calculate latency percentiles
    const latencies = [...this.decisionMetrics.latencies].sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p99 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0;

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unhealthy > healthy || !this.dispatcher.isRunning()) {
      status = 'unhealthy';
    } else if (degraded > healthy * 0.5) {
      status = 'degraded';
    }

    const fallbackRate = this.decisionMetrics.total > 0
      ? this.decisionMetrics.fallbackCount / this.decisionMetrics.total
      : 0;

    const response: SchedulerStatusResponse = {
      status,
      uptime: Math.floor((now.getTime() - this.startTime.getTime()) / 1000),
      workers: { healthy, degraded, unhealthy },
      predictions: {
        taskTypes: this.predictionStats.size,
        avgConfidence: Math.round(avgConfidence * 100) / 100,
      },
      decisions: {
        total: this.decisionMetrics.total,
        fallbackRate: Math.round(fallbackRate * 100) / 100,
      },
      latency: {
        p50: Math.round(p50 * 100) / 100,
        p99: Math.round(p99 * 100) / 100,
      },
    };

    res.json(response);
  };

  /**
   * GET /scheduler/workers
   * Returns list of workers with current state
   */
  getWorkers = (_req: Request, res: Response): void => {
    const workers = this.registry.getAll();
    const available = this.registry.getAvailable();

    const response: WorkerListResponse = {
      workers,
      total: workers.length,
      available: available.length,
    };

    res.json(response);
  };

  /**
   * GET /scheduler/predictions
   * Returns current prediction states
   */
  getPredictions = (_req: Request, res: Response): void => {
    const taskTypes = Array.from(this.predictionStats.keys());
    const states: Record<string, { avgConfidence: number; totalPredictions: number; lastUpdated: string }> = {};

    for (const [taskType, stats] of this.predictionStats) {
      states[taskType] = {
        avgConfidence: Math.round(stats.avgConfidence * 100) / 100,
        totalPredictions: stats.totalPredictions,
        lastUpdated: stats.lastUpdated.toISOString(),
      };
    }

    const response: PredictionStateResponse = {
      taskTypes,
      states,
    };

    res.json(response);
  };

  /**
   * PUT /scheduler/config
   * Updates runtime configuration
   */
  updateConfig = (req: Request, res: Response): void => {
    const updates: ConfigUpdateRequest = req.body;

    if (updates.fallbackThreshold !== undefined) {
      if (typeof updates.fallbackThreshold !== 'number' || updates.fallbackThreshold < 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'fallbackThreshold must be a positive number',
          correlationId: req.correlationId,
        });
        return;
      }
      this.config.fallbackThreshold = updates.fallbackThreshold;
    }

    if (updates.heartbeatTimeoutMs !== undefined) {
      if (typeof updates.heartbeatTimeoutMs !== 'number' || updates.heartbeatTimeoutMs < 1000) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'heartbeatTimeoutMs must be at least 1000ms',
          correlationId: req.correlationId,
        });
        return;
      }
      this.config.heartbeatTimeoutMs = updates.heartbeatTimeoutMs;
    }

    res.json({
      message: 'Configuration updated',
      config: {
        fallbackThreshold: this.config.fallbackThreshold,
        heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      },
    });
  };

  /**
   * POST /scheduler/override
   * Manually selects a worker for a task
   */
  override = async (req: Request, res: Response): Promise<void> => {
    const { taskId, taskType, workerId, payload }: OverrideRequest = req.body;

    // Validate required fields
    if (!taskId || !taskType || !workerId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'taskId, taskType, and workerId are required',
        correlationId: req.correlationId,
      });
      return;
    }

    // Verify worker exists and is available
    const worker = this.registry.get(workerId);
    if (!worker) {
      res.status(404).json({
        error: 'Not Found',
        message: `Worker ${workerId} not found`,
        correlationId: req.correlationId,
      });
      return;
    }

    if (worker.status === 'offline' || worker.status === 'draining') {
      res.status(400).json({
        error: 'Bad Request',
        message: `Worker ${workerId} is ${worker.status} and cannot accept tasks`,
        correlationId: req.correlationId,
      });
      return;
    }

    // Create task and dispatch
    const task: Task = {
      id: taskId,
      type: taskType,
      payload: payload || {},
      priority: 999, // High priority for manual override
      createdAt: new Date(),
      metadata: {
        maxRetries: 0, // No retries for manual override
      },
    };

    try {
      const result = await this.dispatcher.dispatchTask(task);

      if (result.success) {
        const response: OverrideResponse = {
          success: true,
          taskId,
          workerId: result.decision.workerId,
          message: 'Task manually assigned to worker',
        };
        res.json(response);
      } else {
        res.status(500).json({
          error: 'Dispatch Failed',
          message: result.error || 'Failed to dispatch task',
          correlationId: req.correlationId,
        });
      }
    } catch (error) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to dispatch task',
        correlationId: req.correlationId,
      });
    }
  };

  /**
   * DELETE /scheduler/predictions/:taskType
   * Resets predictions for a specific task type
   */
  resetPredictions = (req: Request, res: Response): void => {
    const { taskType } = req.params;

    if (!taskType) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'taskType parameter is required',
        correlationId: req.correlationId,
      });
      return;
    }

    const existed = this.predictionStats.has(taskType);
    this.predictionStats.delete(taskType);

    res.json({
      message: existed
        ? `Predictions for task type '${taskType}' have been reset`
        : `No predictions found for task type '${taskType}'`,
      taskType,
      reset: existed,
    });
  };

  /**
   * Record a scheduling decision for metrics tracking
   * Called internally after each dispatch
   */
  recordDecision(taskType: string, confidence: number, usedFallback: boolean, latencyMs: number): void {
    this.decisionMetrics.total++;
    if (usedFallback) {
      this.decisionMetrics.fallbackCount++;
    }

    // Keep last 1000 latencies for percentile calculation
    this.decisionMetrics.latencies.push(latencyMs);
    if (this.decisionMetrics.latencies.length > 1000) {
      this.decisionMetrics.latencies.shift();
    }

    // Update prediction stats
    const existing = this.predictionStats.get(taskType);
    if (existing) {
      const totalPredictions = existing.totalPredictions + 1;
      const avgConfidence = (existing.avgConfidence * existing.totalPredictions + confidence) / totalPredictions;
      this.predictionStats.set(taskType, {
        avgConfidence,
        totalPredictions,
        lastUpdated: new Date(),
      });
    } else {
      this.predictionStats.set(taskType, {
        avgConfidence: confidence,
        totalPredictions: 1,
        lastUpdated: new Date(),
      });
    }
  }

  /**
   * Get current config (read-only)
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  /**
   * Get the predictor instance
   * Useful for checking predictor readiness
   */
  getPredictor(): Predictor {
    return this.predictor;
  }
}
