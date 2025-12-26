// Production configuration
export const productionConfig = {
  // MongoDB connection options optimized for production
  mongoose: {
    serverSelectionTimeoutMS: 30000, // 30 seconds for production
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    maxPoolSize: 50, // Higher pool size for production
    minPoolSize: 10,
    maxIdleTimeMS: 30000,
    retryWrites: true,
    retryReads: true,
    // Additional production options
    bufferMaxEntries: 0, // Disable mongoose buffering
    bufferCommands: false,
  },
  
  // Rate limiting for production (should use Redis in production)
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
  },
  
  // CORS for production
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
    credentials: true,
  },
  
  // Logging
  logging: {
    level: 'info', // Use 'error' for minimal logging
    verbose: false,
  },
};

