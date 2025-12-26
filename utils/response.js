/**
 * Standardized API Response Utility
 * Ensures consistent response format across all endpoints
 */

export const sendSuccess = (res, data = null, message = null, statusCode = 200) => {
  const response = {
    success: true,
  };
  
  if (data !== null) {
    response.data = data;
  }
  
  if (message) {
    response.message = message;
  }
  
  return res.status(statusCode).json(response);
};

export const sendError = (res, error, statusCode = 500) => {
  const response = {
    success: false,
    error: typeof error === 'string' ? error : error.message || 'An unexpected error occurred',
  };
  
  return res.status(statusCode).json(response);
};

export const sendValidationError = (res, errors) => {
  return res.status(400).json({
    success: false,
    error: 'Validation failed',
    errors: Array.isArray(errors) ? errors : [errors],
  });
};

