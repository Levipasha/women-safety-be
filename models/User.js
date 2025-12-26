import mongoose from 'mongoose';

// User model
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    accountId: { type: String, required: true, unique: true, uppercase: true },
    displayName: { type: String, trim: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // If set, this user is a child
    children: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Array of child user IDs
    currentLocation: {
      latitude: { type: Number },
      longitude: { type: Number },
      address: { type: String },
      timestamp: { type: Date },
    },
    isAppEnabled: { type: Boolean, default: true }, // App toggle state
    batteryLevel: { type: Number, default: 100 }, // Battery percentage (0-100)
    isCharging: { type: Boolean, default: false }, // Is device charging
    batteryUpdatedAt: { type: Date }, // Last battery update timestamp
    activeJourney: {
      isActive: { type: Boolean, default: false },
      from: {
        name: { type: String },
        address: { type: String },
        coordinates: {
          lat: { type: Number },
          lng: { type: Number },
        },
      },
      to: {
        name: { type: String },
        address: { type: String },
        coordinates: {
          lat: { type: Number },
          lng: { type: Number },
        },
      },
      selectedRoutePath: [[Number]], // Array of [lat, lng] coordinates
      deviationDetected: { type: Boolean, default: false },
      deviationAlertSent: { type: Boolean, default: false },
      deviationAlertTime: { type: Date },
      startedAt: { type: Date },
    },
    emergencyRecordings: [
      {
        audioUrl: { type: String }, // Cloudinary URL
        cloudinaryPublicId: { type: String },
        timestamp: { type: String },
        duration: { type: Number }, // Duration in seconds
        fileSize: { type: Number }, // File size in bytes
      },
    ],
    emergencyContacts: [
      {
        id: { type: String, required: true }, // Frontend-generated ID
        name: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },
      },
    ],
  },
  { timestamps: true, collection: 'users' } // ensure documents are stored in the "users" collection only
);

// Add indexes for frequently queried fields to improve query performance
// Note: email and accountId already have indexes from unique: true, so we skip those
userSchema.index({ parentId: 1 });
userSchema.index({ 'currentLocation.latitude': 1, 'currentLocation.longitude': 1 });
userSchema.index({ 'activeJourney.isActive': 1 });

export const User = mongoose.model('User', userSchema);

