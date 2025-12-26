import { safeLog } from '../utils/logger.js';

// Centralized error handler middleware (must be last)
export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred';

  // Log error details for debugging (only in development or with specific flag)
  const isDevelopment = process.env.NODE_ENV !== 'production';
  if (isDevelopment || process.env.LOG_ERRORS_VERBOSE === 'true') {
    safeLog.error(`Server error: ${message}`, {
      statusCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
      error: err.stack,
      body: req.body,
      query: req.query,
    });
  } else {
    safeLog.error(`Server error: ${message}`, {
      statusCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
  }

  res.status(statusCode).json({
    error: isDevelopment ? message : 'An unexpected error occurred',
    details: isDevelopment && err.details ? err.details : undefined,
  });
};

// 404 Not Found handler
export const notFoundHandler = (req, res, next) => {
  res.status(404).json({ error: `Not Found - ${req.originalUrl}` });
};

