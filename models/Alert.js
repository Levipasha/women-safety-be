import mongoose from 'mongoose';

// Simple Alert model
const alertSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    location: { type: Object },
  },
  { timestamps: true }
);

export const Alert = mongoose.model('Alert', alertSchema);

