// Script to check contacts in the database
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { User } from './models/User.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function checkContacts() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');

        // Find the specific user
        const user = await User.findOne({ email: 'vamshi.c2035@gmail.com' });

        if (!user) {
            console.log('❌ User not found!');
            await mongoose.disconnect();
            process.exit(1);
        }

        console.log('📧 User Email:', user.email);
        console.log('🆔 User ID:', user._id.toString());
        console.log('📱 Emergency Contacts Count:', user.emergencyContacts?.length || 0);
        console.log('\n📋 Contacts:');

        if (user.emergencyContacts && user.emergencyContacts.length > 0) {
            user.emergencyContacts.forEach((contact, index) => {
                console.log(`  ${index + 1}. ${contact.name} - ${contact.phone} (ID: ${contact.id})`);
            });
        } else {
            console.log('  No contacts found!');
        }

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

checkContacts();
