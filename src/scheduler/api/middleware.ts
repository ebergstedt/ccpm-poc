/**
 * API Middleware - Authentication and Rate Limiting
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

/**
 * Extend Express Request to include correlation ID
 */
declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

/**
 * API key authentication middleware
 * Validates the X-Scheduler-Key header against configured API keys
 */
export function apiKeyAuth(validKeys: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.header('X-Scheduler-Key');

    if (!apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing X-Scheduler-Key header',
        correlationId: req.correlationId,
      });
      return;
    }

    if (!validKeys.has(apiKey)) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid API key',
        correlationId: req.correlationId,
      });
      return;
    }

    next();
  };
}

/**
 * Rate limiting middleware configuration
 * Limits to 100 requests per minute per API key
 */
export function createRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per window
    keyGenerator: (req: Request): string => {
      // Use API key for rate limiting, fallback to IP
      return req.header('X-Scheduler-Key') || req.ip || 'unknown';
    },
    message: {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Max 100 requests per minute.',
      retryAfter: 60,
    },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
  });
}

/**
 * Correlation ID middleware
 * Adds a unique correlation ID to each request for tracing
 */
export function correlationId(req: Request, _res: Response, next: NextFunction): void {
  req.correlationId = req.header('X-Correlation-ID') || uuidv4();
  next();
}

/**
 * Request logging middleware
 * Logs request details with correlation ID
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Log on response finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      apiKey: req.header('X-Scheduler-Key')?.slice(0, 8) + '...',
    }));
  });

  next();
}

/**
 * Error handling middleware
 * Catches unhandled errors and returns consistent error response
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    correlationId: req.correlationId,
    error: err.name,
    message: err.message,
    stack: err.stack,
  }));

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    correlationId: req.correlationId,
  });
}
