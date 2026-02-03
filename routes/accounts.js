import express from 'express';
import { body, param, validationResult } from 'express-validator';
import { User } from '../models/User.js';
import { EmergencyAlert } from '../models/EmergencyAlert.js';
import { validateCoordinates } from '../utils/helpers.js';
import { safeLog } from '../utils/logger.js';
import { sendError, sendSuccess, sendValidationError } from '../utils/response.js';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/index.js';

const router = express.Router();

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendValidationError(res, errors.array());
  }
  next();
};

// Factory function to create account routes with dependencies
export const createAccountRoutes = (authenticate, connectedUsers, io) => {
  // Add a child account (by account ID)
  router.post('/add',
    authenticate,
    [
      body('accountId').trim().notEmpty().withMessage('Account ID is required'),
      body('displayName').optional().trim(),
      body('group').optional().isIn(['family', 'friends']).withMessage('Invalid group value'),
    ],
    validate,
    async (req, res) => {
      try {
        const { accountId, displayName, group = 'family' } = req.body;

        // Find the child user by account ID
        const childUser = await User.findOne({ accountId: accountId.toUpperCase() });
        if (!childUser) {
          return sendError(res, 'Account with this ID not found', 404);
        }

        // Check if already a child
        if (childUser.parentId) {
          return sendError(res, 'This account is already linked to another parent', 400);
        }

        // Check if trying to add self
        if (childUser._id.toString() === req.user._id.toString()) {
          return sendError(res, 'Cannot add yourself as a child', 400);
        }

        // Link child to parent
        childUser.parentId = req.user._id;
        childUser.childGroup = group;
        if (displayName) {
          childUser.displayName = displayName;
        }
        await childUser.save();

        // Add to parent's children array if not already there
        if (!req.user.children.includes(childUser._id)) {
          req.user.children.push(childUser._id);
          await req.user.save();
        }

        return sendSuccess(res, {
          child: {
            id: childUser._id.toString(),
            name: childUser.name,
            accountId: childUser.accountId,
            displayName: childUser.displayName || childUser.name,
            group: childUser.childGroup,
          },
        }, 'Child account added successfully');
      } catch (err) {
        safeLog.error('Error adding child account', err);
        return sendError(res, 'Failed to add child account', 500);
      }
    }
  );

  // Get all child accounts with their locations
  router.get('/children', authenticate, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 100, 100);
      const skip = (page - 1) * limit;

      const children = await User.find({ parentId: req.user._id })
        .select('name accountId displayName currentLocation updatedAt isAppEnabled activeJourney batteryLevel isCharging batteryUpdatedAt profilePicture childGroup')
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await User.countDocuments({ parentId: req.user._id });

      const childrenWithLocation = children.map((child) => ({
        id: child._id.toString(),
        name: child.name,
        accountId: child.accountId,
        displayName: child.displayName || child.name,
        location: child.currentLocation || null,
        lastUpdated: child.currentLocation?.timestamp || child.updatedAt,
        isAppEnabled: child.isAppEnabled !== undefined ? child.isAppEnabled : true,
        activeJourney: child.activeJourney || null,
        batteryLevel: child.batteryLevel !== undefined ? child.batteryLevel : 100,
        isCharging: child.isCharging || false,
        batteryUpdatedAt: child.batteryUpdatedAt || null,
        profilePicture: child.profilePicture || null,
        group: child.childGroup || 'family',
      }));

      return sendSuccess(res, {
        children: childrenWithLocation,
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
      safeLog.error('Error fetching children', err);
      return sendError(res, 'Failed to fetch children accounts', 500);
    }
  });

  // Remove a child account
  router.delete('/children/:childId',
    authenticate,
    [
      param('childId').isMongoId().withMessage('Invalid child ID format'),
    ],
    validate,
    async (req, res) => {
      try {
        const { childId } = req.params;

        // Find child by ID and verify it belongs to this parent
        const childUser = await User.findOne({
          _id: childId,
          parentId: req.user._id
        });

        if (!childUser) {
          return sendError(res, 'Child account not found or does not belong to you', 404);
        }

        // Remove parent link from child
        childUser.parentId = null;
        childUser.displayName = undefined;
        await childUser.save();

        // Refresh parent user to get latest data
        const parentUser = await User.findById(req.user._id);
        if (parentUser) {
          // Remove child from parent's children array
          parentUser.children = parentUser.children.filter(
            (id) => id.toString() !== childId
          );
          await parentUser.save();
        }

        return sendSuccess(res, null, 'Child account removed successfully');
      } catch (err) {
        safeLog.error('Error removing child account', err);
        return sendError(res, 'Failed to remove child account', 500);
      }
    }
  );

  // Update current location (for children to update their location)
  router.put('/location',
    authenticate,
    [
      body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
      body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
      body('address').optional().trim(),
      body('batteryLevel').optional().isInt({ min: 0, max: 100 }),
      body('isCharging').optional().isBoolean(),
    ],
    validate,
    async (req, res) => {
      try {
        const { latitude, longitude, address, batteryLevel, isCharging } = req.body;

        // Additional validation using helper
        if (!validateCoordinates(latitude, longitude)) {
          return sendError(res, 'Invalid coordinates', 400);
        }

        req.user.currentLocation = {
          latitude,
          longitude,
          address: address || null,
          timestamp: new Date(),
        };

        // Update battery info if provided
        if (batteryLevel !== undefined) {
          req.user.batteryLevel = batteryLevel;
          req.user.isCharging = !!isCharging;
          req.user.batteryUpdatedAt = new Date();
        }

        await req.user.save();

        // LIVE SOS TRACKING: If user has an active SOS, broadcast movement to rescuers
        try {
          const activeAlert = await EmergencyAlert.findOne({
            userId: req.user._id,
            isActive: true,
            expiresAt: { $gt: new Date() }
          });

          if (activeAlert) {
            safeLog.info(`Victim moving - broadcasting SOS update`, { alertId: activeAlert.alertId });
            io.to(`sos:${activeAlert.alertId}`).emit('sos-location-update', {
              alertId: activeAlert.alertId,
              latitude,
              longitude,
              address: address || req.user.currentLocation.address,
              timestamp: req.user.currentLocation.timestamp
            });
          }
        } catch (sosErr) {
          safeLog.error('Error broadcasting SOS update', sosErr);
        }

        return sendSuccess(res, {
          location: req.user.currentLocation,
        }, 'Location updated successfully');
      } catch (err) {
        safeLog.error('Error updating location', err);
        return sendError(res, 'Failed to update location', 500);
      }
    }
  );

  // Update app enabled state
  router.put('/app-state',
    authenticate,
    [
      body('isAppEnabled').isBoolean().withMessage('isAppEnabled must be a boolean'),
    ],
    validate,
    async (req, res) => {
      try {
        const { isAppEnabled } = req.body;

        req.user.isAppEnabled = isAppEnabled;
        await req.user.save();

        // Broadcast app state change via WebSocket to all connected clients
        io.to(`user:${req.user._id}`).emit('app-state-changed', {
          userId: req.user._id.toString(),
          isAppEnabled: req.user.isAppEnabled,
        });

        // If user is a child, notify parent
        if (req.user.parentId) {
          io.to(`parent:${req.user.parentId}`).emit('child-app-state-changed', {
            childId: req.user._id.toString(),
            isAppEnabled: req.user.isAppEnabled,
          });
        }

        // If user is a parent, notify all children
        if (req.user.children && req.user.children.length > 0) {
          safeLog.info(`Broadcasting to children`, { childrenCount: req.user.children.length });
          req.user.children.forEach((childId) => {
            const childIdStr = childId.toString();
            const parentIdStr = req.user._id.toString();

            io.to(`child:${childIdStr}`).emit('parent-app-state-changed', {
              parentId: parentIdStr,
              isAppEnabled: req.user.isAppEnabled,
            });

            io.to(`user:${childIdStr}`).emit('parent-app-state-changed', {
              parentId: parentIdStr,
              isAppEnabled: req.user.isAppEnabled,
            });
          });
        }

        safeLog.info(`Broadcasted app state change`, { userId: req.user._id, isAppEnabled });

        return sendSuccess(res, {
          isAppEnabled: req.user.isAppEnabled,
        }, 'App state updated successfully');
      } catch (err) {
        safeLog.error('Error updating app state', err);
        return sendError(res, 'Failed to update app state', 500);
      }
    }
  );

  // Get app enabled state
  router.get('/app-state', authenticate, async (req, res) => {
    try {
      return sendSuccess(res, {
        isAppEnabled: req.user.isAppEnabled !== undefined ? req.user.isAppEnabled : true,
      });
    } catch (err) {
      safeLog.error('Error fetching app state', err);
      return sendError(res, 'Failed to fetch app state', 500);
    }
  });
  // Update battery status
  router.post('/battery-status',
    authenticate,
    [
      body('batteryLevel').isInt({ min: 0, max: 100 }).withMessage('Battery level must be between 0 and 100'),
      body('isCharging').isBoolean().withMessage('isCharging must be a boolean'),
    ],
    validate,
    async (req, res) => {
      try {
        const { batteryLevel, isCharging } = req.body;

        req.user.batteryLevel = batteryLevel;
        req.user.isCharging = isCharging;
        req.user.batteryUpdatedAt = new Date();
        await req.user.save();

        // If user is a child, notify parent via WebSocket
        if (req.user.parentId) {
          io.to(`parent:${req.user.parentId}`).emit('child-battery-updated', {
            childId: req.user._id.toString(),
            batteryLevel,
            isCharging,
            timestamp: req.user.batteryUpdatedAt,
          });
        }

        return sendSuccess(res, {
          batteryLevel: req.user.batteryLevel,
          isCharging: req.user.isCharging,
          batteryUpdatedAt: req.user.batteryUpdatedAt,
        }, 'Battery status updated successfully');
      } catch (err) {
        safeLog.error('Error updating battery status', err);
        return sendError(res, 'Failed to update battery status', 500);
      }
    }
  );


  // Get emergency contacts
  router.get('/contacts', authenticate, async (req, res) => {
    try {
      safeLog.info(`[Contacts] Fetching contacts for user: ${req.user._id}`);
      // Refresh user to get latest contacts
      const user = await User.findById(req.user._id);
      if (!user) {
        safeLog.error(`[Contacts] User not found: ${req.user._id}`);
        return sendError(res, 'User not found', 404);
      }
      const contactsCount = user.emergencyContacts?.length || 0;
      safeLog.info(`[Contacts] Found ${contactsCount} contacts for user ${req.user._id}`);
      return sendSuccess(res, {
        contacts: user?.emergencyContacts || [],
      });
    } catch (err) {
      safeLog.error('Error fetching contacts', err);
      return sendError(res, 'Failed to fetch contacts', 500);
    }
  });

  // Add emergency contact
  router.post('/contacts',
    authenticate,
    [
      body('id').trim().notEmpty().withMessage('Contact ID is required'),
      body('name').trim().notEmpty().withMessage('Contact name is required'),
      body('phone').trim().notEmpty().withMessage('Contact phone is required'),
      body('priority').optional().isIn(['primary', 'secondary', 'none']).withMessage('Invalid priority value'),
    ],
    validate,
    async (req, res) => {
      try {
        const { id, name, phone, priority = 'none' } = req.body;
        safeLog.info(`[Contacts] Adding contact for user ${req.user._id}`, { id, name, phone, priority });

        // Refresh user to get latest data
        const user = await User.findById(req.user._id);
        if (!user) {
          safeLog.error(`[Contacts] User not found: ${req.user._id}`);
          return sendError(res, 'User not found', 404);
        }

        safeLog.info(`[Contacts] User found, current contacts count: ${user.emergencyContacts?.length || 0}`);

        // Check if contact with this ID already exists
        const existingContact = user.emergencyContacts.find(c => c.id === id);
        if (existingContact) {
          safeLog.warn(`[Contacts] Contact with ID ${id} already exists`);
          return sendError(res, 'Contact with this ID already exists', 400);
        }

        // Add new contact
        user.emergencyContacts.push({ id, name, phone, priority });
        safeLog.info(`[Contacts] Contact added to array, new count: ${user.emergencyContacts.length}`);

        await user.save();
        safeLog.info(`[Contacts] User saved successfully with new contact`);

        return sendSuccess(res, {
          contact: { id, name, phone, priority },
        }, 'Contact added successfully');
      } catch (err) {
        safeLog.error('[Contacts] Error adding contact', err);
        return sendError(res, 'Failed to add contact', 500);
      }
    }
  );

  // Sync all emergency contacts (replace entire array) - MUST be before /:contactId routes
  router.put('/contacts/sync',
    authenticate,
    [
      body('contacts').isArray().withMessage('Contacts must be an array'),
      body('contacts.*.id').trim().notEmpty().withMessage('Each contact must have an ID'),
      body('contacts.*.name').trim().notEmpty().withMessage('Each contact must have a name'),
      body('contacts.*.phone').trim().notEmpty().withMessage('Each contact must have a phone'),
      body('contacts.*.priority').optional().isIn(['primary', 'secondary', 'none']).withMessage('Invalid priority value'),
    ],
    validate,
    async (req, res) => {
      try {
        const { contacts } = req.body;
        safeLog.info(`[Contacts] Syncing ${contacts.length} contacts for user ${req.user._id}`);

        // Refresh user to get latest data
        const user = await User.findById(req.user._id);
        if (!user) {
          safeLog.error(`[Contacts] User not found: ${req.user._id}`);
          return sendError(res, 'User not found', 404);
        }

        // Replace all contacts
        user.emergencyContacts = contacts;
        await user.save();
        safeLog.info(`[Contacts] Contacts synced successfully, total: ${user.emergencyContacts.length}`);

        return sendSuccess(res, {
          contacts: user.emergencyContacts,
        }, 'Contacts synced successfully');
      } catch (err) {
        safeLog.error('[Contacts] Error syncing contacts', err);
        return sendError(res, 'Failed to sync contacts', 500);
      }
    }
  );

  // Update emergency contact
  router.put('/contacts/:contactId',
    authenticate,
    [
      param('contactId').notEmpty().withMessage('Contact ID is required'),
      body('name').optional().trim().notEmpty().withMessage('Contact name cannot be empty'),
      body('phone').optional().trim().notEmpty().withMessage('Contact phone cannot be empty'),
      body('priority').optional().isIn(['primary', 'secondary', 'none']).withMessage('Invalid priority value'),
    ],
    validate,
    async (req, res) => {
      try {
        const { contactId } = req.params;
        const { name, phone, priority } = req.body;
        safeLog.info(`[Contacts] Updating contact ${contactId} for user ${req.user._id}`, { name, phone, priority });

        // Refresh user to get latest data
        const user = await User.findById(req.user._id);
        if (!user) {
          return sendError(res, 'User not found', 404);
        }

        // Find contact and update
        const contact = user.emergencyContacts.find(c => c.id === contactId);
        if (!contact) {
          safeLog.warn(`[Contacts] Contact ${contactId} not found`);
          return sendError(res, 'Contact not found', 404);
        }

        if (name !== undefined) contact.name = name;
        if (phone !== undefined) contact.phone = phone;
        if (priority !== undefined) contact.priority = priority;

        await user.save();
        safeLog.info(`[Contacts] Contact ${contactId} updated successfully`);

        return sendSuccess(res, {
          contact: { id: contact.id, name: contact.name, phone: contact.phone, priority: contact.priority },
        }, 'Contact updated successfully');
      } catch (err) {
        safeLog.error('[Contacts] Error updating contact', err);
        return sendError(res, 'Failed to update contact', 500);
      }
    }
  );

  // Delete emergency contact
  router.delete('/contacts/:contactId',
    authenticate,
    [
      param('contactId').notEmpty().withMessage('Contact ID is required'),
    ],
    validate,
    async (req, res) => {
      try {
        const { contactId } = req.params;
        safeLog.info(`[Contacts] Deleting contact ${contactId} for user ${req.user._id}`);

        // Refresh user to get latest data
        const user = await User.findById(req.user._id);
        if (!user) {
          return sendError(res, 'User not found', 404);
        }

        const beforeCount = user.emergencyContacts.length;
        // Remove contact
        user.emergencyContacts = user.emergencyContacts.filter(c => c.id !== contactId);
        await user.save();

        safeLog.info(`[Contacts] Contact deleted, count: ${beforeCount} -> ${user.emergencyContacts.length}`);

        return sendSuccess(res, null, 'Contact deleted successfully');
      } catch (err) {
        safeLog.error('[Contacts] Error deleting contact', err);
        return sendError(res, 'Failed to delete contact', 500);
      }
    }
  );

  // Get user phone number
  router.get('/phone-number', authenticate, async (req, res) => {
    try {
      return sendSuccess(res, {
        userPhoneNumber: req.user.userPhoneNumber || null,
      });
    } catch (err) {
      safeLog.error('Error fetching phone number', err);
      return sendError(res, 'Failed to fetch phone number', 500);
    }
  });


  // Update user phone number
  router.put('/phone-number',
    authenticate,
    [
      body('phoneNumber').trim().notEmpty().withMessage('Phone number is required'),
    ],
    validate,
    async (req, res) => {
      try {
        const { phoneNumber } = req.body;
        safeLog.info(`[PhoneNumber] Updating phone number for user ${req.user._id}`);

        req.user.userPhoneNumber = phoneNumber;
        await req.user.save();

        safeLog.info(`[PhoneNumber] Phone number updated successfully`);

        return sendSuccess(res, {
          userPhoneNumber: req.user.userPhoneNumber,
        }, 'Phone number updated successfully');
      } catch (err) {
        safeLog.error('[PhoneNumber] Error updating phone number', err);
        return sendError(res, 'Failed to update phone number', 500);
      }
    }
  );

  // Update profile picture
  router.post('/profile-picture',
    authenticate,
    [
      body('imageBase64').notEmpty().withMessage('Image data is required'),
    ],
    validate,
    async (req, res) => {
      try {
        const { imageBase64 } = req.body;
        safeLog.info(`[ProfilePicture] Updating profile picture for user ${req.user._id}`);

        // Convert base64 to buffer
        let imageBuffer;
        try {
          const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
          imageBuffer = Buffer.from(base64Data, 'base64');
        } catch (error) {
          return sendError(res, 'Invalid image data format', 400);
        }

        // Upload to Cloudinary
        let cloudinaryResult;
        try {
          cloudinaryResult = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              {
                folder: 'profile-pictures',
                resource_type: 'image',
                public_id: `profile_${req.user._id}`,
                overwrite: true,
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(imageBuffer);
          });
        } catch (error) {
          safeLog.error('[ProfilePicture] Cloudinary upload error', error);
          return sendError(res, 'Failed to upload image to Cloudinary', 500);
        }

        // Update user model
        req.user.profilePicture = cloudinaryResult.secure_url;
        await req.user.save();

        safeLog.info(`[ProfilePicture] Profile picture updated successfully`);

        return sendSuccess(res, {
          profilePicture: req.user.profilePicture,
        }, 'Profile picture updated successfully');
      } catch (err) {
        safeLog.error('[ProfilePicture] Error updating profile picture', err);
        return sendError(res, 'Failed to update profile picture', 500);
      }
    }
  );

  return router;
};

