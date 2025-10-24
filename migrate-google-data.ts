#!/usr/bin/env node

/**
 * Google API Optimization Migration Script (TypeScript)
 *
 * Usage:
 *   ts-node migrate-google-data.ts
 *
 * Requirements:
 * - GOOGLE_API_KEY set in environment
 * - Redis running
 * - MongoDB connection configured (MONGODB_URI or defaults to local)
 */

import mongoose from 'mongoose';
import {
  batchProcessFacilities,
  getApiUsageStats,
  type FacilityGoogleData,
  type BatchGoogleResult,
  type PlaceDetails,
} from './src/services/googleService';
import Facility from './src/models/NursingFacility';

// Configuration
const BATCH_SIZE = 50; // Process 50 facilities at a time
const DELAY_BETWEEN_BATCHES = 2000; // 2 seconds delay between batches

async function connectToDatabase(): Promise<void> {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursinghome';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

type MinimalFacility = {
  _id: mongoose.Types.ObjectId;
  provider_name: string | null;
  zip_code: string | null;
  city_town: string | null;
};

async function migrateFacilities(): Promise<void> {
  try {
    console.log('🚀 Starting Google API optimization migration...\n');

    // Get total facility count
    const totalFacilities = await Facility.countDocuments();
    console.log(`📊 Total facilities to process: ${totalFacilities}\n`);

    if (totalFacilities === 0) {
      console.log('❌ No facilities found in database');
      return;
    }

    // Get all facility IDs and basic info
    const facilities = (await Facility.find({})
      .select('_id provider_name zip_code city_town')
      .lean()) as unknown as MinimalFacility[];

    console.log(`📋 Found ${facilities.length} facilities\n`);

    // Convert to batch processing format
    const facilityData: FacilityGoogleData[] = facilities.map((facility) => ({
      facilityId: facility._id.toString(),
      providerName: facility.provider_name || '',
      zipCode: facility.zip_code || undefined,
      cityTown: facility.city_town || undefined,
    }));

    // Process in batches
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < facilityData.length; i += BATCH_SIZE) {
      const batch = facilityData.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(facilityData.length / BATCH_SIZE);

      console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} facilities)`);

      try {
        const results: BatchGoogleResult[] = await batchProcessFacilities(batch);

        // Update database with results
        const updatePromises = results.map(async (result) => {
          if (result.placeDetails) {
            const details: PlaceDetails = result.placeDetails;
            const cacheData = {
              placeId: result.placeId,
              googleName: details.name,
              rating: details.rating,
              lat: details.lat,
              lng: details.lng,
              photoReferences: details.photos.slice(0, 4).map((p) => p.photo_reference),
              reviews: details.reviews.slice(0, 10).map((r) => ({
                author_name: r.author_name,
                rating: r.rating,
                text: r.text,
                // `time` is what we store in the schema
                time: (r as any).time ?? undefined,
              })),
              lastUpdated: new Date(),
            } as const;

            await Facility.updateOne(
              { _id: result.facilityId },
              { $set: { googleCache: cacheData } }
            );
            return true;
          }
          return false;
        });

        const updateResults = await Promise.allSettled(updatePromises);
        const batchSuccessCount = updateResults.filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value).length;
        const batchErrorCount = batch.length - batchSuccessCount;

        successCount += batchSuccessCount;
        errorCount += batchErrorCount;
        processedCount += batch.length;

        console.log(`✅ Batch ${batchNumber} complete: ${batchSuccessCount}/${batch.length} successful`);
        console.log(`📊 Progress: ${processedCount}/${facilityData.length} (${((processedCount / facilityData.length) * 100).toFixed(1)}%)\n`);

        // Show API usage stats
        const apiStats = getApiUsageStats();
        console.log(`📈 API Usage: ${apiStats.totalRequests} requests, ${apiStats.cacheHits} cache hits, ${apiStats.cacheMisses} cache misses`);
        console.log(`💰 Estimated cost so far: $${(apiStats.totalRequests * 0.017).toFixed(4)}\n`);

        // Delay between batches to respect rate limits
        if (i + BATCH_SIZE < facilityData.length) {
          console.log(`⏳ Waiting ${DELAY_BETWEEN_BATCHES / 1000} seconds before next batch...\n`);
          await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
      } catch (error: any) {
        console.error(`❌ Batch ${batchNumber} failed:`, error?.message || error);
        errorCount += batch.length;
        processedCount += batch.length;
      }
    }

    // Final summary
    console.log('\n🎉 Migration Complete!\n');
    console.log(`📊 Final Results:`);
    console.log(`   Total facilities: ${facilityData.length}`);
    console.log(`   Successfully processed: ${successCount}`);
    console.log(`   Failed: ${errorCount}`);
    console.log(`   Success rate: ${((successCount / facilityData.length) * 100).toFixed(1)}%\n`);

    const finalApiStats = getApiUsageStats();
    console.log(`📈 Final API Usage:`);
    console.log(`   Total requests: ${finalApiStats.totalRequests}`);
    console.log(`   Cache hits: ${finalApiStats.cacheHits}`);
    console.log(`   Cache misses: ${finalApiStats.cacheMisses}`);
    console.log(
      `   Cache hit rate: ${finalApiStats.totalRequests > 0 ? ((finalApiStats.cacheHits / finalApiStats.totalRequests) * 100).toFixed(1) : 0}%`
    );
    console.log(`   Estimated total cost: $${(finalApiStats.totalRequests * 0.017).toFixed(4)}\n`);

    console.log('💡 Next steps:');
    console.log('   1. Monitor cache hit rates using GET /api/place/stats');
    console.log('   2. Use batch processing for new facilities');
    console.log('   3. Set up regular cache refresh schedule');
    console.log('   4. Monitor Google API usage in Google Cloud Console\n');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  }
}

async function main(): Promise<void> {
  try {
    await connectToDatabase();
    await migrateFacilities();
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Migration interrupted by user');
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Migration terminated');
  await mongoose.disconnect();
  process.exit(0);
});

// Run the migration
void main();


