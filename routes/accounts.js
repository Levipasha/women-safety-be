import express from 'express';
import { body, param, validationResult } from 'express-validator';
import { User } from '../models/User.js';
import { validateCoordinates } from '../utils/helpers.js';
import { safeLog } from '../utils/logger.js';
import { sendError, sendSuccess, sendValidationError } from '../utils/response.js';

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
    ],
    validate,
    async (req, res) => {
      try {
        const { accountId, displayName } = req.body;

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
            id: childUser._id,
            name: childUser.name,
            accountId: childUser.accountId,
            displayName: childUser.displayName || childUser.name,
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
        .select('name accountId displayName currentLocation updatedAt isAppEnabled activeJourney batteryLevel isCharging batteryUpdatedAt')
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
    ],
    validate,
    async (req, res) => {
      try {
        const { latitude, longitude, address } = req.body;

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
        await req.user.save();

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
    ],
    validate,
    async (req, res) => {
      try {
        const { id, name, phone } = req.body;
        safeLog.info(`[Contacts] Adding contact for user ${req.user._id}`, { id, name, phone });

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
        user.emergencyContacts.push({ id, name, phone });
        safeLog.info(`[Contacts] Contact added to array, new count: ${user.emergencyContacts.length}`);

        await user.save();
        safeLog.info(`[Contacts] User saved successfully with new contact`);

        return sendSuccess(res, {
          contact: { id, name, phone },
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
    ],
    validate,
    async (req, res) => {
      try {
        const { contactId } = req.params;
        const { name, phone } = req.body;
        safeLog.info(`[Contacts] Updating contact ${contactId} for user ${req.user._id}`);

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

        await user.save();
        safeLog.info(`[Contacts] Contact ${contactId} updated successfully`);

        return sendSuccess(res, {
          contact: { id: contact.id, name: contact.name, phone: contact.phone },
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

  return router;
};

