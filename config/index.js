/**
 * Centralized Configuration Module
 * Loads and validates all environment variables
 */

import dotenv from 'dotenv';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Load environment variables from backend/.env only
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Validate required environment variables
const requiredEnvVars = {
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\nPlease set these in your .env file. See .env.example for reference.');
  process.exit(1);
}

// Validate JWT_SECRET is not the default insecure value
if (requiredEnvVars.JWT_SECRET === 'dev-secret-change-me' || requiredEnvVars.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be set to a strong value (minimum 32 characters)');
  console.error('   Please generate a secure random string for JWT_SECRET in your .env file');
  process.exit(1);
}

// Get allowed origins from environment variable
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:19006'];

export const config = {
  port: process.env.PORT || 4000,
  mongodb: {
    uri: requiredEnvVars.MONGODB_URI,
    options: {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 5,
      maxIdleTimeMS: 30000,
      retryWrites: true,
      retryReads: true,
    },
  },
  jwt: {
    secret: requiredEnvVars.JWT_SECRET,
    expiresIn: '7d',
  },
  cloudinary: {
    cloud_name: requiredEnvVars.CLOUDINARY_CLOUD_NAME,
    api_key: requiredEnvVars.CLOUDINARY_API_KEY,
    api_secret: requiredEnvVars.CLOUDINARY_API_SECRET,
  },
  cors: {
    allowedOrigins,
  },
  isDevelopment: process.env.NODE_ENV !== 'production',
};

