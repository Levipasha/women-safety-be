import express from 'express';
import { query, validationResult } from 'express-validator';
import { Alert } from '../models/Alert.js';
import { safeLog } from '../utils/logger.js';
import { sendSuccess, sendError, sendValidationError } from '../utils/response.js';

const router = express.Router();

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendValidationError(res, errors.array());
  }
  next();
};

// Factory function to create alert routes with dependencies
export const createAlertRoutes = (authenticate) => {
  // Create alert (requires authentication)
  router.post('/',
    authenticate,
    async (req, res) => {
      try {
        const alert = new Alert(req.body);
        await alert.save();
        return sendSuccess(res, alert, null, 201);
      } catch (err) {
        safeLog.error('Error creating alert', err);
        return sendError(res, 'Failed to create alert', 400);
      }
    }
  );

  // List alerts (requires authentication) with pagination
  router.get('/',
    authenticate,
    [
      query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
      query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    ],
    validate,
    async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100); // Max 100 per page
        const skip = (page - 1) * limit;

        const alerts = await Alert.find()
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean();
        
        const total = await Alert.countDocuments();

        return sendSuccess(res, {
          alerts,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNextPage: page * limit < total,
            hasPrevPage: page > 1,
          },
        });
      } catch (err) {
        safeLog.error('Error fetching alerts', err);
        return sendError(res, 'Failed to fetch alerts', 500);
      }
    }
  );

  return router;
};

