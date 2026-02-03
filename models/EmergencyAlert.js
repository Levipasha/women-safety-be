import mongoose from 'mongoose';

// Emergency Alert model for nearby SOS broadcasts
const emergencyAlertSchema = new mongoose.Schema(
    {
        alertId: { type: String, required: true, unique: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        userName: { type: String, required: true },
        accountId: { type: String, required: true },
        primaryContact: {
            name: { type: String, required: true },
            phone: { type: String, required: true },
        },
        secondaryContact: {
            name: { type: String, required: true },
            phone: { type: String, required: true },
        },
        userPhone: { type: String, required: true },
        profilePicture: { type: String },
        location: {
            latitude: { type: Number, required: true },
            longitude: { type: Number, required: true },
            address: { type: String },
        },
        timestamp: { type: Date, required: true, default: Date.now },
        expiresAt: { type: Date, required: true }, // 24 hours from creation
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true, collection: 'emergency_alerts' }
);

// Index for efficient querying
emergencyAlertSchema.index({ userId: 1, timestamp: -1 });
emergencyAlertSchema.index({ expiresAt: 1 }); // For TTL cleanup
emergencyAlertSchema.index({ isActive: 1, expiresAt: 1 });
emergencyAlertSchema.index({ 'location.latitude': 1, 'location.longitude': 1 });

// TTL index to automatically delete expired alerts after 24 hours
emergencyAlertSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmergencyAlert = mongoose.model('EmergencyAlert', emergencyAlertSchema);
