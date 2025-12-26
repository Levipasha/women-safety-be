// Script to remove duplicate contacts from the database
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { User } from './models/User.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function cleanupDuplicateContacts() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Find all users
        const users = await User.find({});
        console.log(`Found ${users.length} users`);

        for (const user of users) {
            if (user.emergencyContacts && user.emergencyContacts.length > 0) {
                const originalCount = user.emergencyContacts.length;
                console.log(`\nUser ${user.email} has ${originalCount} contacts`);

                // Remove duplicates based on phone number
                const uniqueContacts = [];
                const seenPhones = new Set();

                for (const contact of user.emergencyContacts) {
                    const normalizedPhone = contact.phone.replace(/\s|-|\(|\)/g, '');
                    if (!seenPhones.has(normalizedPhone)) {
                        seenPhones.add(normalizedPhone);
                        uniqueContacts.push(contact);
                    } else {
                        console.log(`  - Removing duplicate: ${contact.name} (${contact.phone})`);
                    }
                }

                if (uniqueContacts.length < originalCount) {
                    user.emergencyContacts = uniqueContacts;
                    await user.save();
                    console.log(`  ✅ Cleaned up ${originalCount - uniqueContacts.length} duplicates`);
                    console.log(`  📊 Final count: ${uniqueContacts.length} unique contacts`);
                } else {
                    console.log(`  ✅ No duplicates found`);
                }
            }
        }

        console.log('\n✅ Cleanup complete!');
        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

cleanupDuplicateContacts();
