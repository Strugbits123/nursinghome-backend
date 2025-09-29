// forceCreateIndex.ts

import mongoose, { Schema } from 'mongoose';

// --- Recreate the schema definition needed for the index command ---
// Note: We use the exact field names and types from your main model
const NursingFacilitySchema = new Schema({
    // Only need the geo fields for index creation
    latitude: { type: Number },
    longitude: { type: Number },
}, { collection: 'nursingfacilities' }); // 💡 IMPORTANT: Specify the collection name

// 💡 REQUIRED: Define the 2d index using the exact parameters
NursingFacilitySchema.index(
    { longitude: 1, latitude: 1 }, 
    { 
        '2d': 1, // Must be explicitly set to '2d' for the legacy index type
        min: -180, 
        max: 180, 
        name: 'geo_2d_fix', 
        background: true 
    } as any // Use 'as any' to bypass the TS error on the '2d' property
);

// Register a temporary model to run the command against
const FacilityTemp = mongoose.model('NursingFacilityTemp', NursingFacilitySchema);


async function forceIndexCreation() {
    // ⚠️ IMPORTANT: Replace this with your actual MongoDB URI
    const MONGO_URI = "mongodb://localhost:27017/nursinghome"; 

    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(MONGO_URI);
        
        console.log("Attempting to force 2D index creation (geo_2d_fix) using Mongoose syncIndexes()...");
        
        // 💡 FIX: Use the Mongoose model's syncIndexes() method
        await FacilityTemp.syncIndexes(); 

        console.log("✅ Index creation command sent successfully! Index should now exist.");
        console.log("You can now run your main server.");

    } catch (err) {
        console.error("Index creation failed (this might be fine if the index already existed and was unchanged):", err);
    } finally {
        await mongoose.connection.close();
    }
}

// Run the script
forceIndexCreation();