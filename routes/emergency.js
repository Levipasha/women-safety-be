import express from 'express';
import { body, validationResult } from 'express-validator';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { User } from '../models/User.js';
import { EmergencyImage } from '../models/EmergencyImage.js';
import { validateCoordinates } from '../utils/helpers.js';
import { safeLog, sanitizeAccountId } from '../utils/logger.js';
import { sendSuccess, sendError, sendValidationError } from '../utils/response.js';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

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

// Factory function to create emergency routes with dependencies
export const createEmergencyRoutes = (authenticate, io) => {
  // Upload emergency image to Cloudinary and save to MongoDB
  router.post('/upload-image',
    authenticate,
    [
      body('imageBase64').notEmpty().withMessage('Image data is required'),
      body('location').optional().isObject(),
      body('triggerType').optional().trim(),
    ],
    validate,
    async (req, res) => {
      try {
        const { imageBase64, location, triggerType } = req.body;

        // Convert base64 to buffer
        let imageBuffer;
        try {
          // Remove data URL prefix if present (data:image/jpeg;base64,)
          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
          imageBuffer = Buffer.from(base64Data, 'base64');
        } catch (error) {
          return sendError(res, 'Invalid image data format', 400);
        }

        // Upload to Cloudinary
        let cloudinaryResult;
        try {
          safeLog.info(`Uploading image to Cloudinary`, { userId: req.user._id });
          cloudinaryResult = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              {
                folder: 'emergency-images',
                resource_type: 'image',
                public_id: `emergency_${req.user._id}_${Date.now()}`,
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(imageBuffer);
          });
          safeLog.info(`Image uploaded to Cloudinary successfully`);
        } catch (error) {
          safeLog.error('Cloudinary upload error', error);
          return sendError(res, 'Failed to upload image to Cloudinary', 500);
        }

        // Save image URL link to MongoDB
        safeLog.info(`Saving image link to MongoDB`, { userId: req.user._id });
        const emergencyImage = await EmergencyImage.create({
          userId: req.user._id,
          imageUrl: cloudinaryResult.secure_url,
          cloudinaryPublicId: cloudinaryResult.public_id,
          location: location || null,
          triggerType: triggerType || 'shutdown_attempt',
          timestamp: new Date(),
        });
        safeLog.info(`Image link saved to MongoDB`);

        return sendSuccess(res, {
          imageUrl: cloudinaryResult.secure_url,
          imageId: emergencyImage._id,
          publicId: cloudinaryResult.public_id,
        });
      } catch (error) {
        safeLog.error('Error uploading emergency image', error);
        return sendError(res, 'Failed to upload emergency image', 500);
      }
    }
  );

  // Upload emergency audio recording to Cloudinary and save metadata to user
  // FIXED: Added authenticate middleware
  router.post('/upload-audio',
    authenticate,
    upload.single('audio'),
    [
      body('timestamp').optional().isISO8601().withMessage('Invalid timestamp format'),
    ],
    validate,
    async (req, res) => {
      try {
        safeLog.info('Received audio upload request', { userId: req.user._id });
        
        const { timestamp } = req.body;
        const audioFile = req.file;
        
        if (!audioFile) {
          return sendError(res, 'Audio file is required', 400);
        }

        // Use authenticated user's accountId instead of from request body
        const accountId = req.user.accountId;

        safeLog.info(`Uploading audio (${(audioFile.size / 1024).toFixed(2)} KB) to Cloudinary...`);

        // Upload audio to Cloudinary
        let cloudinaryResult;
        try {
          cloudinaryResult = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              {
                folder: 'emergency-audio',
                resource_type: 'video', // Audio files use 'video' resource type in Cloudinary
                public_id: `audio_${accountId}_${Date.now()}`,
                format: 'm4a', // Preserve audio format
              },
              (error, result) => {
                if (error) {
                  safeLog.error('Cloudinary audio upload error', error);
                  reject(error);
                } else {
                  resolve(result);
                }
              }
            ).end(audioFile.buffer);
          });
          
          safeLog.info(`Audio uploaded to Cloudinary successfully`);
        } catch (error) {
          safeLog.error('Cloudinary audio upload failed', error);
          return sendError(res, 'Failed to upload audio to Cloudinary', 500);
        }

        // Save audio metadata to user's emergency recordings array
        if (!req.user.emergencyRecordings) {
          req.user.emergencyRecordings = [];
        }
        
        req.user.emergencyRecordings.push({
          audioUrl: cloudinaryResult.secure_url,
          cloudinaryPublicId: cloudinaryResult.public_id,
          timestamp: timestamp || new Date().toISOString(),
          duration: cloudinaryResult.duration || 0,
          fileSize: audioFile.size,
        });
        
        // Keep only last 50 recordings to prevent bloat
        if (req.user.emergencyRecordings.length > 50) {
          req.user.emergencyRecordings = req.user.emergencyRecordings.slice(-50);
        }
        
        await req.user.save();
        
        safeLog.info(`Audio metadata saved`, { accountId: sanitizeAccountId(req.user.accountId), recordingsCount: req.user.emergencyRecordings.length });

        return sendSuccess(res, {
          url: cloudinaryResult.secure_url,
          cloudinaryPublicId: cloudinaryResult.public_id,
          duration: cloudinaryResult.duration,
        });
      } catch (error) {
        safeLog.error('Error uploading emergency audio', error);
        return sendError(res, 'Failed to upload emergency audio', 500);
      }
    }
  );

  // Get emergency images for a user
  router.get('/images', authenticate, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
      const skip = (page - 1) * limit;

      const images = await EmergencyImage.find({ userId: req.user._id })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      
      const total = await EmergencyImage.countDocuments({ userId: req.user._id });

      return sendSuccess(res, {
        images,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1,
        },
      });
    } catch (error) {
      safeLog.error('Error fetching emergency images', error);
      return sendError(res, 'Failed to fetch emergency images', 500);
    }
  });

  // Find nearby users within radius (in km)
  router.post('/nearby/users',
    authenticate,
    [
      body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
      body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
      body('radiusKm').optional().isFloat({ min: 0, max: 100 }).withMessage('Radius must be between 0 and 100 km'),
    ],
    validate,
    async (req, res) => {
      try {
        const { latitude, longitude, radiusKm = 5 } = req.body; // Default 5km radius
        
        // Additional validation
        if (!validateCoordinates(latitude, longitude)) {
          return sendError(res, 'Invalid coordinates', 400);
        }

        if (!req.user.currentLocation || !req.user.currentLocation.latitude) {
          return sendError(res, 'Your location is not available. Please enable location updates.', 400);
        }

        // Find all users with active locations and app enabled
        const allUsers = await User.find({
          _id: { $ne: req.user._id }, // Exclude self
          isAppEnabled: true,
          'currentLocation.latitude': { $exists: true },
          'currentLocation.longitude': { $exists: true },
        }).select('name accountId currentLocation');

        // Calculate distance for each user
        const nearbyUsers = [];
        for (const user of allUsers) {
          if (user.currentLocation && user.currentLocation.latitude) {
            const distance = calculateDistance(
              latitude,
              longitude,
              user.currentLocation.latitude,
              user.currentLocation.longitude
            );

            if (distance <= radiusKm) {
              nearbyUsers.push({
                userId: user._id.toString(),
                name: user.name,
                accountId: user.accountId,
                distance: distance,
                location: {
                  latitude: user.currentLocation.latitude,
                  longitude: user.currentLocation.longitude,
                  address: user.currentLocation.address || null,
                },
              });
            }
          }
        }

        // Sort by distance (closest first)
        nearbyUsers.sort((a, b) => a.distance - b.distance);

        safeLog.info(`Found nearby users`, { count: nearbyUsers.length, radiusKm, userId: req.user._id });

        return sendSuccess(res, {
          nearbyUsers,
          count: nearbyUsers.length,
          radiusKm,
        });
      } catch (error) {
        safeLog.error('Error finding nearby users', error);
        return sendError(res, 'Failed to find nearby users', 500);
      }
    }
  );

  // Broadcast SOS alert to nearby users
  router.post('/sos-broadcast',
    authenticate,
    [
      body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
      body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
      body('address').optional().trim(),
    ],
    validate,
    async (req, res) => {
      try {
        const { latitude, longitude, address } = req.body;
        
        // Additional validation
        if (!validateCoordinates(latitude, longitude)) {
          return sendError(res, 'Invalid coordinates', 400);
        }

        const radiusKm = 5; // 5km radius for nearby users
        const alertId = `sos_${req.user._id}_${Date.now()}`;

        // Find nearby users
        const allUsers = await User.find({
          _id: { $ne: req.user._id },
          isAppEnabled: true,
          'currentLocation.latitude': { $exists: true },
          'currentLocation.longitude': { $exists: true },
        }).select('name accountId currentLocation _id');

        const nearbyUserIds = [];
        const alertData = {
          alertId,
          userId: req.user._id.toString(),
          userName: req.user.name,
          accountId: req.user.accountId,
          location: {
            latitude,
            longitude,
            address: address || req.user.currentLocation?.address || null,
          },
          timestamp: new Date().toISOString(),
        };

        // Calculate distance and send alert to nearby users
        for (const user of allUsers) {
          if (user.currentLocation && user.currentLocation.latitude) {
            const distance = calculateDistance(
              latitude,
              longitude,
              user.currentLocation.latitude,
              user.currentLocation.longitude
            );

            if (distance <= radiusKm) {
              nearbyUserIds.push(user._id.toString());
              
              // Send WebSocket alert to nearby user
              const alertWithDistance = {
                ...alertData,
                distance: parseFloat(distance.toFixed(2)),
              };
              
              // Emit to user's room
              io.to(`user:${user._id}`).emit('nearby-sos-alert', alertWithDistance);
              safeLog.info(`SOS alert sent to nearby user`, { distance: distance.toFixed(2), recipientName: user.name });
            }
          }
        }

        safeLog.info(`SOS broadcast complete`, { notifiedCount: nearbyUserIds.length });

        return sendSuccess(res, {
          alertId,
          nearbyUsersNotified: nearbyUserIds.length,
          nearbyUserIds,
        });
      } catch (error) {
        safeLog.error('Error broadcasting SOS', error);
        return sendError(res, 'Failed to broadcast SOS alert', 500);
      }
    }
  );

  return router;
};

