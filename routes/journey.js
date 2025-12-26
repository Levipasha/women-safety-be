import express from 'express';
import { body, validationResult } from 'express-validator';
import { validateCoordinates } from '../utils/helpers.js';
import { safeLog } from '../utils/logger.js';
import { sendSuccess, sendError, sendValidationError } from '../utils/response.js';

const router = express.Router();

// Helper function to calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in km
}

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendValidationError(res, errors.array());
  }
  next();
};

// Factory function to create journey routes with dependencies
export const createJourneyRoutes = (authenticate, connectedUsers, io) => {
  // Start journey (child starts journey from A to B with selected route path)
  router.post('/start',
    authenticate,
    [
      body('from').isObject().withMessage('From location is required'),
      body('from.coordinates').isObject().withMessage('From coordinates are required'),
      body('from.coordinates.lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
      body('from.coordinates.lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
      body('to').isObject().withMessage('To location is required'),
      body('to.coordinates').isObject().withMessage('To coordinates are required'),
      body('to.coordinates.lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
      body('to.coordinates.lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
      body('selectedRoutePath').optional().isArray(),
    ],
    validate,
    async (req, res) => {
      try {
        const { from, to, selectedRoutePath } = req.body;

        // Additional validation
        if (!validateCoordinates(from.coordinates.lat, from.coordinates.lng) ||
            !validateCoordinates(to.coordinates.lat, to.coordinates.lng)) {
          return sendError(res, 'Invalid coordinates', 400);
        }

        req.user.activeJourney = {
          isActive: true,
          from,
          to,
          selectedRoutePath: selectedRoutePath || [],
          deviationDetected: false,
          deviationAlertSent: false,
          deviationAlertTime: null,
          startedAt: new Date(),
        };
        await req.user.save();

        // Notify parent via WebSocket
        if (req.user.parentId) {
          const parentSocketId = connectedUsers.get(req.user.parentId.toString());
          if (parentSocketId) {
            io.to(parentSocketId).emit('child-journey-started', {
              childId: req.user._id.toString(),
              childName: req.user.displayName || req.user.name,
              journey: req.user.activeJourney,
            });
            safeLog.info(`[Journey] Notified parent that child started journey`, { childId: req.user._id, parentId: req.user.parentId });
          }
        }

        return sendSuccess(res, {
          journey: req.user.activeJourney,
        }, 'Journey started successfully');
      } catch (err) {
        safeLog.error('Error starting journey', err);
        return sendError(res, 'Failed to start journey', 500);
      }
    }
  );

  // Stop journey (child ends journey)
  router.post('/stop', authenticate, async (req, res) => {
    try {
      req.user.activeJourney = {
        isActive: false,
        from: null,
        to: null,
        selectedRoutePath: [],
        deviationDetected: false,
        deviationAlertSent: false,
        deviationAlertTime: null,
        startedAt: null,
      };
      await req.user.save();

      // Notify parent via WebSocket
      if (req.user.parentId) {
        const parentSocketId = connectedUsers.get(req.user.parentId.toString());
        if (parentSocketId) {
          io.to(parentSocketId).emit('child-journey-stopped', {
            childId: req.user._id.toString(),
            childName: req.user.displayName || req.user.name,
          });
          safeLog.info(`[Journey] Notified parent that child stopped journey`, { childId: req.user._id, parentId: req.user.parentId });
        }
      }

      return sendSuccess(res, null, 'Journey stopped successfully');
    } catch (err) {
      safeLog.error('Error stopping journey', err);
      return sendError(res, 'Failed to stop journey', 500);
    }
  });

  // Respond to deviation alert (child confirms they're okay)
  router.post('/deviation-response',
    authenticate,
    [
      body('isOkay').isBoolean().withMessage('isOkay must be a boolean'),
    ],
    validate,
    async (req, res) => {
      try {
        const { isOkay } = req.body;
        
        if (isOkay) {
          // Child confirmed they're okay - reset deviation flags
          req.user.activeJourney.deviationDetected = false;
          req.user.activeJourney.deviationAlertSent = false;
          req.user.activeJourney.deviationAlertTime = null;
          await req.user.save();
          
          safeLog.info(`[Journey] Child responded to deviation alert - they're okay`, { userId: req.user._id });
          
          return sendSuccess(res, null, 'Response recorded successfully');
        } else {
          return sendError(res, 'Invalid response', 400);
        }
      } catch (err) {
        safeLog.error('Error recording deviation response', err);
        return sendError(res, 'Failed to record response', 500);
      }
    }
  );

  // Check route deviation and alert parent if needed
  router.post('/check-deviation',
    authenticate,
    [
      body('currentLat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
      body('currentLng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    ],
    validate,
    async (req, res) => {
      try {
        const { currentLat, currentLng } = req.body;
        
        // Additional validation
        if (!validateCoordinates(currentLat, currentLng)) {
          return sendError(res, 'Invalid coordinates', 400);
        }
        
        const journey = req.user.activeJourney;
        
        if (!journey || !journey.isActive || !journey.selectedRoutePath || journey.selectedRoutePath.length === 0) {
          return sendSuccess(res, { onRoute: true, message: 'No active journey or route path' });
        }
        
        // Calculate minimum distance to route path
        let minDistance = Infinity;
        journey.selectedRoutePath.forEach(point => {
          const distance = calculateDistance(currentLat, currentLng, point[0], point[1]);
          if (distance < minDistance) {
            minDistance = distance;
          }
        });
        
        // Threshold: 200 meters off route
        const DEVIATION_THRESHOLD = 0.2; // km
        const isOffRoute = minDistance > DEVIATION_THRESHOLD;
        
        safeLog.info(`[Journey] Deviation check - Distance from route: ${(minDistance * 1000).toFixed(0)}m, Off route: ${isOffRoute}`);
        
        if (isOffRoute && !journey.deviationAlertSent) {
          // First time deviation detected - set flag and alert time
          journey.deviationDetected = true;
          journey.deviationAlertSent = true;
          journey.deviationAlertTime = new Date();
          await req.user.save();
          
          safeLog.warn(`[Journey] Child went off route! Alert sent.`, { userId: req.user._id });
          
          return sendSuccess(res, {
            onRoute: false,
            distanceFromRoute: minDistance,
            alertSent: true,
            message: 'You seem to have gone off your planned route. Are you okay?'
          });
        } else if (isOffRoute && journey.deviationAlertSent) {
          // Check if alert timeout exceeded (5 minutes)
          const alertTime = new Date(journey.deviationAlertTime);
          const now = new Date();
          const minutesSinceAlert = (now - alertTime) / 1000 / 60;
          
          if (minutesSinceAlert > 5 && req.user.parentId) {
            // Alert parent - no response for 5 minutes
            const parentSocketId = connectedUsers.get(req.user.parentId.toString());
            if (parentSocketId) {
              io.to(parentSocketId).emit('child-deviation-alert', {
                childId: req.user._id.toString(),
                childName: req.user.displayName || req.user.name,
                currentLocation: { lat: currentLat, lng: currentLng },
                distanceFromRoute: minDistance,
                timestamp: new Date(),
              });
              safeLog.warn(`[Journey] PARENT ALERT! Child off route with no response for 5 minutes`, { userId: req.user._id });
            }
            
            return sendSuccess(res, {
              onRoute: false,
              distanceFromRoute: minDistance,
              parentAlerted: true,
              message: 'Parent has been notified'
            });
          } else {
            return sendSuccess(res, {
              onRoute: false,
              distanceFromRoute: minDistance,
              alertPending: true,
              message: 'Waiting for response'
            });
          }
        } else {
          return sendSuccess(res, {
            onRoute: true,
            distanceFromRoute: minDistance,
            message: 'On route'
          });
        }
      } catch (err) {
        safeLog.error('Error checking deviation', err);
        return sendError(res, 'Failed to check deviation', 500);
      }
    }
  );

  return router;
};

