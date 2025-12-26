import bcrypt from 'bcryptjs';
import express from 'express';
import { User } from '../models/User.js';
import { generateAccountId, validateEmail, validatePassword, sanitizeString } from '../utils/helpers.js';
import { safeLog } from '../utils/logger.js';
import { createSignToken } from '../middleware/auth.js';

const router = express.Router();

// Factory function to create auth routes with dependencies
export const createAuthRoutes = (JWT_SECRET, authLimiter) => {
  const signToken = createSignToken(JWT_SECRET);

  // Register route
  router.post('/register', authLimiter, async (req, res) => {
    try {
      const { email, password, name } = req.body;
      
      // Validate required fields
      if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name are required' });
      }
      
      // Validate email format
      if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      
      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      
      // Sanitize name
      const sanitizedName = sanitizeString(name);
      if (!sanitizedName) {
        return res.status(400).json({ error: 'Name cannot be empty' });
      }
      
      const existing = await User.findOne({ email: email.toLowerCase().trim() });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      
      // Generate unique account ID
      let accountId;
      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 10) {
        accountId = generateAccountId(name).toUpperCase();
        const existingAccount = await User.findOne({ accountId });
        if (!existingAccount) {
          isUnique = true;
        }
        attempts++;
      }
      
      if (!isUnique) {
        return res.status(500).json({ error: 'Failed to generate unique account ID. Please try again.' });
      }
      
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({ 
        email: email.toLowerCase().trim(), 
        passwordHash, 
        name: sanitizedName,
        accountId 
      });
      const token = signToken(user._id.toString());
      res.status(201).json({ 
        token, 
        user: { 
          id: user._id, 
          email: user.email, 
          name: user.name,
          accountId: user.accountId 
        } 
      });
    } catch (err) {
      safeLog.error('Error in register', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Login route
  router.post('/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      
      // Validate email format
      if (!validateEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      const user = await User.findOne({ email: email.toLowerCase().trim() });
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const token = signToken(user._id.toString());
      res.json({ 
        token, 
        user: { 
          id: user._id, 
          email: user.email,
          name: user.name,
          accountId: user.accountId,
          isAppEnabled: user.isAppEnabled !== undefined ? user.isAppEnabled : true
        } 
      });
    } catch (err) {
      safeLog.error('Error in login', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  return router;
};

