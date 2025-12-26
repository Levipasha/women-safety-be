import mongoose from 'mongoose';

const emergencyImageSchema = new mongoose.Schema(
  {
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: true,
      index: true 
    },
    imageUrl: { type: String, required: true }, // Cloudinary URL
    cloudinaryPublicId: { type: String }, // Cloudinary public ID for deletion
    location: {
      latitude: { type: Number },
      longitude: { type: Number },
      address: { type: String },
    },
    timestamp: { type: Date, default: Date.now, index: true },
    triggerType: { 
      type: String, 
      enum: ['shutdown_attempt', 'manual', 'sos'],
      default: 'shutdown_attempt'
    },
    sentToContacts: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index for efficient queries
emergencyImageSchema.index({ userId: 1, timestamp: -1 });

export const EmergencyImage = mongoose.model('EmergencyImage', emergencyImageSchema);

