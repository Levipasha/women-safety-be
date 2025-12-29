import { v2 as cloudinary } from 'cloudinary';
import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import mongoose from 'mongoose';
import morgan from 'morgan';
import { Server } from 'socket.io';
import { config } from './config/index.js';
import { createAuthenticate, createAuthenticateSocket } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { User } from './models/User.js';
import { createAccountRoutes } from './routes/accounts.js';
import { createAlertRoutes } from './routes/alerts.js';
import { createAuthRoutes } from './routes/auth.js';
import { createEmergencyRoutes } from './routes/emergency.js';
import { createJourneyRoutes } from './routes/journey.js';
import { createMissingPosterRoutes } from './routes/missingPosters.js';
import { safeLog } from './utils/logger.js';

const app = express();
const httpServer = createServer(app);

// Trust proxy - Required for Railway/cloud deployments
// This allows Express to trust the X-Forwarded-For header for accurate client IP detection
app.set('trust proxy', true);

// Configure Cloudinary
cloudinary.config(config.cloudinary);

// Test Cloudinary connection function
const testCloudinary = async () => {
  try {
    await cloudinary.api.ping();
    console.log('✅ Cloudinary connected');
  } catch (error) {
    console.error('❌ Cloudinary connection error:', error.message);
    console.log('⚠️  Cloudinary uploads may fail. Please check your credentials.');
  }
};

// Store connected users: userId -> socketId
const connectedUsers = new Map();

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: config.cors.allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Create authentication middleware
const authenticate = createAuthenticate(config.jwt.secret, User);
const authenticateSocket = createAuthenticateSocket(config.jwt.secret, User);

// Middleware - CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (config.cors.allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enhanced request logging with morgan
const morganFormat = config.isDevelopment ? 'dev' : 'combined';
app.use(morgan(morganFormat, {
  // Skip logging for health checks to reduce noise
  skip: (req) => req.path === '/api/health' || req.path === '/health',
}));

// Rate limiting
let authLimiter = (req, res, next) => next(); // Default: no rate limiting
let apiLimiter = (req, res, next) => next(); // Default: no rate limiting

try {
  // Dynamic import for ES modules
  const rateLimitModule = await import('express-rate-limit');
  const rateLimit = rateLimitModule.default || rateLimitModule;

  // General API rate limiter (excludes emergency AND auth endpoints)
  apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window per IP
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for critical emergency endpoints AND auth endpoints
    skip: (req) => {
      const fullPath = req.originalUrl || req.path;
      const relativePath = req.path;

      // Patterns to skip (emergency + auth endpoints)
      const skipPatterns = [
        // Emergency endpoints
        'emergency/sos-broadcast',
        'emergency/upload-image',
        'emergency/upload-audio',
        'accounts/location',
        'accounts/contacts',
        // Auth endpoints (they have their own email-based rate limiting)
        'auth/register',
        'auth/login',
      ];

      // Check if path matches any skip pattern
      const shouldSkip = skipPatterns.some(pattern => {
        return fullPath.includes(pattern) || relativePath.includes(pattern);
      });

      if (shouldSkip) {
        console.log(`[RateLimit] Skipping general API rate limit for: ${fullPath}`);
      }

      return shouldSkip;
    },
  });

  // Auth endpoints rate limiter (email-based instead of IP-based)
  // This allows unlimited users on the same IP (e.g., same WiFi network)
  // while still protecting individual accounts from brute force attacks
  authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per email address (not per IP)
    message: 'Too many login attempts for this account, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    // Rate limit by email instead of IP address
    keyGenerator: (req) => {
      // Use email from request body for login/register
      const email = req.body?.email;
      if (email) {
        return `email:${email.toLowerCase().trim()}`;
      }
      // Fallback to IP if no email provided (shouldn't happen for auth endpoints)
      return `ip:${req.ip}`;
    },
    // Skip rate limiting for specific conditions if needed
    skip: (req) => {
      // During development, you can skip rate limiting
      // return process.env.NODE_ENV === 'development';
      return false; // Keep rate limiting enabled in all environments
    },
  });

  // Apply general rate limiting to all API routes
  app.use('/api/', apiLimiter);

  console.log('✅ Rate limiting enabled');
} catch (error) {
  console.warn('⚠️  express-rate-limit not installed. Rate limiting disabled.');
  console.warn('   Install with: npm install express-rate-limit');
  console.warn('   For production, consider Redis-based rate limiting.');
}

// WebSocket authentication and connection handling
io.use(authenticateSocket);

io.on('connection', (socket) => {
  const userId = socket.userId;
  connectedUsers.set(userId, socket.id);
  safeLog.info(`[WebSocket] User connected`, { userId, socketId: socket.id });

  // Join user's room for targeted updates
  socket.join(`user:${userId}`);

  // Join parent's room if user is a child (for receiving parent updates)
  if (socket.user.parentId) {
    const parentIdStr = socket.user.parentId.toString();
    socket.join(`parent:${parentIdStr}`);
    safeLog.info(`[WebSocket] Child joined parent room`, { userId, parentId: parentIdStr });
  }

  // Join children's rooms if user is a parent (for sending updates to children)
  if (socket.user.children && socket.user.children.length > 0) {
    socket.user.children.forEach((childId) => {
      const childIdStr = childId.toString();
      socket.join(`child:${childIdStr}`);
    });
    safeLog.info(`[WebSocket] Parent joined child rooms`, { userId, childrenCount: socket.user.children.length });
  }

  // IMPORTANT: Every user should join their own child room
  // This ensures parent can send updates to this child via child:${userId}
  socket.join(`child:${userId}`);

  socket.on('disconnect', () => {
    connectedUsers.delete(userId);
    safeLog.info(`[WebSocket] User disconnected`, { userId });
  });
});

// Health check with comprehensive dependency checks
app.get('/api/health', async (_req, res) => {
  const healthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {},
  };

  // Check MongoDB connection
  const dbState = mongoose.connection.readyState;
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbStatus = dbStates[dbState] || 'unknown';

  healthStatus.dependencies.mongodb = {
    status: dbState === 1 ? 'healthy' : 'unhealthy',
    state: dbStatus,
    readyState: dbState,
  };

  // Additional MongoDB connection details
  if (mongoose.connection.readyState === 1) {
    try {
      // Test query to verify database is actually responsive
      await mongoose.connection.db.admin().ping();
      healthStatus.dependencies.mongodb.ping = 'ok';
    } catch (error) {
      healthStatus.dependencies.mongodb.ping = 'failed';
      healthStatus.dependencies.mongodb.pingError = error.message;
      healthStatus.status = 'degraded';
    }
  } else {
    healthStatus.status = 'unhealthy';
  }

  // Check Cloudinary connection
  try {
    await cloudinary.api.ping();
    healthStatus.dependencies.cloudinary = {
      status: 'healthy',
    };
  } catch (error) {
    healthStatus.dependencies.cloudinary = {
      status: 'unhealthy',
      error: error.message,
    };
    healthStatus.status = healthStatus.status === 'unhealthy' ? 'unhealthy' : 'degraded';
  }

  // Determine overall status code
  const statusCode = healthStatus.status === 'ok' ? 200 :
    healthStatus.status === 'degraded' ? 200 : 503;

  res.status(statusCode).json(healthStatus);
});

// Register routes
app.use('/api/auth', createAuthRoutes(config.jwt.secret, authLimiter));
app.use('/api/accounts', createAccountRoutes(authenticate, connectedUsers, io));
app.use('/api/journey', createJourneyRoutes(authenticate, connectedUsers, io));
app.use('/api/emergency', createEmergencyRoutes(authenticate, io));
app.use('/api/alerts', createAlertRoutes(authenticate));
app.use('/api/missing-posters', createMissingPosterRoutes(authenticate));

// Error handling middleware (must be last)
app.use(errorHandler);
app.use(notFoundHandler);

// MongoDB connection event handlers
mongoose.connection.on('connected', () => {
  safeLog.info('MongoDB connected successfully');
});

mongoose.connection.on('error', (err) => {
  safeLog.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  safeLog.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  safeLog.info('MongoDB reconnected');
});

// Handle application termination
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed through app termination');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed through app termination');
  process.exit(0);
});

// Connect to MongoDB with retry logic
const connectWithRetry = async (retries = 5, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await mongoose.connect(config.mongodb.uri, config.mongodb.options);
      console.log('✅ MongoDB connected');

      // Test Cloudinary connection
      await testCloudinary();

      httpServer.listen(config.port, '0.0.0.0', () => {
        const isProduction = !config.isDevelopment;

        console.log(`🚀 Backend running on http://0.0.0.0:${config.port}`);

        if (isProduction) {
          // Production environment (Railway, etc.)
          const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : 'https://women-safety-be-production.up.railway.app';
          console.log(`   🌍 Production URL: ${railwayUrl}`);
        } else {
          // Development environment
          console.log(`   Accessible at http://localhost:${config.port} (local)`);
          console.log(`   Accessible at http://10.0.2.2:${config.port} (Android emulator)`);
        }

        console.log(`🔌 WebSocket server ready for real-time updates`);
      });
      return;
    } catch (err) {
      safeLog.error(`MongoDB connection attempt ${i + 1} failed:`, err);
      if (i < retries - 1) {
        console.log(`Retrying connection in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 1.5; // Exponential backoff
      } else {
        console.error('❌ Failed to connect to MongoDB after', retries, 'attempts');
        console.error('Please check your MongoDB URI and ensure MongoDB is running');
        process.exit(1);
      }
    }
  }
};

connectWithRetry();

