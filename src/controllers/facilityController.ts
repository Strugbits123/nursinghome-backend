import { Request, Response, NextFunction } from "express";
import * as cmsService from "../services/cmsService";
import * as googleService from "../services/googleService";
import axios from "axios";
import { PlaceDetails,
  findPlaceIdByText,  
  getPlaceDetails, 
  getCoordinatesByPlaceName,
  batchProcessFacilities,
  FacilityGoogleData,
  BatchGoogleResult,
  getApiUsageStats,
  resetApiUsageStats } from "../services/googleService";

  import { 
  getCachedPhotoUrl, 
  batchCacheFacilityPhotos,
  getFacilityCachedPhotos,
  getImageCacheStats,
  cleanupExpiredImages
} from '../utils/imageCache'; 

import { summarizeReviews, summarizeReviewsBatch, SummarizeResult } from "../services/aiService";
import Facility from "../models/NursingFacility"; 
import { getCache, setCache, deleteCache } from "../config/redisClient";
import CachedSearchResult from "../models/CachedSearchResult";
import NursingFacility from "../models/NursingFacility";
import mongoose, { PipelineStage } from "mongoose";
import { SponsoredFacility } from '../models/SponsoredFacility';



// Get your API key from environment variables

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000; // 1 year for core details
const REVIEWS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh reviews weekly
const ONE_HOUR_MS = 60 * 60; // 1 hour in seconds

const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";

const SEARCH_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; 
const SEARCH_CACHE_KEY = (query: { lat?: string; lng?: string; q?: string }) => {
    if (query.lat && query.lng) {
        const lat = parseFloat(query.lat).toFixed(4);
        const lng = parseFloat(query.lng).toFixed(4);
        return `search:nearby:${lat}_${lng}`;
    }
    if (query.q) {
        const base = query.q.trim().toLowerCase().replace(/\s+/g, '_');
        return `search:query:${base}`;
    }
    return 'search:invalid';
};


const fetchAndCacheGoogleData = async (facility: any) => {
  const now = new Date();
  const REDIS_KEY = `facility:${facility._id}:google`;

  try {
    // 1️⃣ Try Redis first
    const redisData = await getCache(REDIS_KEY);
    if (redisData) {
      const parsed = JSON.parse(redisData);

      // Core staleness (1 year)
      const lastUpdated = new Date(parsed.lastUpdated || 0);
      const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;

      // Reviews staleness (weekly)
      const reviewsLastUpdated = new Date(parsed.reviewsLastUpdated || parsed.lastUpdated || 0);
      const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;

      if (isCoreStale || areReviewsStale) {
        // 🔁 Refresh in background (non-blocking)
        refreshGoogleDataInBackground(facility, REDIS_KEY);
      }

      // ✅ Return current cached data immediately (limit photos to 4)
      const photoUrls = (parsed.photoReferences || [])
        .slice(0, 4)
        .map((ref: string) => googleService.getPhotoUrl(ref));

      return {
        googleName: parsed.googleName,
        rating: parsed.rating,
        lat: parsed.lat,
        lng: parsed.lng,
        photos: photoUrls,
        reviews: parsed.reviews || [],
        user_ratings_total: parsed.user_ratings_total || null, // Add this

      };
    }

    // 2️⃣ Try MongoDB cache next
    const mongoCache = facility.googleCache;
    if (mongoCache && mongoCache.lastUpdated) {
      const lastUpdated = new Date(mongoCache.lastUpdated);
      const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
      const reviewsLastUpdated = new Date(mongoCache.reviewsLastUpdated || mongoCache.lastUpdated);
      const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;

      // Rebuild photo URLs
      const photoUrls = mongoCache.photoReferences.map((ref: string) =>
        googleService.getPhotoUrl(ref)
      );

      // Cache it in Redis for faster next time
      await setCache(REDIS_KEY, JSON.stringify(mongoCache));

      // If stale → background refresh
      if (isCoreStale || areReviewsStale) {
        refreshGoogleDataInBackground(facility, REDIS_KEY);
      }

      return {
        googleName: mongoCache.googleName,
        rating: mongoCache.rating,
        lat: mongoCache.lat,
        lng: mongoCache.lng,
        photos: photoUrls,
        reviews: mongoCache.reviews,
        user_ratings_total: mongoCache.user_ratings_total || null, // Add this

      };
    }

    // 3️⃣ If nothing in Redis or Mongo — fetch fresh from Google
    return await refreshGoogleDataInBackground(facility, REDIS_KEY);
  } catch (err) {
    console.error(`Google fetch failed for ${facility.provider_name}:`, err);
  }

  // 4️⃣ Fallback
  return {
    googleName: null,
    rating: null,
    lat: null,
    lng: null,
    photos: [],
    reviews: [],
    user_ratings_total: null, // Add this

  };
};


/**
 * 🔁 Helper — refreshes Google data and updates Redis + Mongo
 * @param facility Facility object
 * @param REDIS_KEY Redis cache key
 * @param immediateReturn If true, return the fetched data; else run in background
 */

// async function refreshGoogleDataInBackground(
//   facility: any,
//   REDIS_KEY: string,
//   immediateReturn: boolean = false
// ) {
//   try {
//     // 🚀 Faster for single facility: avoid batch processor
//     const placeIdCandidates = await Promise.allSettled([
//       findPlaceIdByText(facility.provider_name),
//       findPlaceIdByText(`${facility.provider_name} ${facility.zip_code || ""}`.trim()),
//       findPlaceIdByText(`${facility.provider_name} ${facility.city_town || ""}`.trim()),
//     ]);

//     const fulfilledCandidate = placeIdCandidates.find(
//       (r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled" && !!(r as PromiseFulfilledResult<string | null>).value
//     );
//     const placeId = (fulfilledCandidate?.value ?? undefined) as string | undefined;

//     if (!placeId) {
//       return null;
//     }

//     const details = await getPlaceDetails(placeId);
//     if (!details) {
//       return null;
//     }

//     const photoReferences = details.photos
//       ? details.photos.slice(0, 4).map((p: any) => p.photo_reference)
//       : [];

//     const reviews = (details.reviews || []).slice(0, 10).map((r: any) => ({
//       author_name: r.author_name,
//       rating: r.rating,
//       text: r.text,
//       relative_time_description: r.relative_time_description,
//       profile_photo_url: r.profile_photo_url,
//       author_url: r.author_url,
//     }));

//     const now = new Date();
//     const newCache = {
//       placeId,
//       googleName: details.name,
//       rating: details.rating,
//       lat: details.lat,
//       lng: details.lng,
//       photoReferences,
//       reviews,
//       lastUpdated: now,
//       reviewsLastUpdated: now,
//     };

//     await Promise.allSettled([
//       setCache(REDIS_KEY, JSON.stringify(newCache)),
//       Facility.updateOne(
//         { _id: facility._id },
//         { $set: { googleCache: newCache } },
//         { upsert: true }
//       ),
//     ]);

//     if (immediateReturn) {
//       return {
//         googleName: newCache.googleName,
//         rating: newCache.rating,
//         lat: newCache.lat,
//         lng: newCache.lng,
//         photos: photoReferences.map((ref) => googleService.getPhotoUrl(ref)),
//         reviews,
//       };
//     }
//   } catch (err) {
//     console.error(`Background refresh failed for ${facility.provider_name}:`, err);
//   }

//   return null;
// }


// // Background refresh function
// async function refreshGoogleDataInBackground(facility: any, redisKey: string) {
//   try {
//     console.log(`🔄 Refreshing Google data for facility: ${facility._id}`);
    
//     // Find place by facility address
//     const placeId = await findPlaceIdByText(facility.location);
//     if (!placeId) {
//       console.log(`❌ No place found for facility: ${facility.provider_name}`);
//       return;
//     }

//     // Get place details
//     const placeDetails = await getPlaceDetails(placeId);
//     if (!placeDetails) {
//       console.log(`❌ No place details found for place: ${placeId}`);
//       return;
//     }

//     // Prepare cache data
//     const cacheData = {
//       googleName: placeDetails.name,
//       rating: placeDetails.rating,
//       lat: placeDetails.lat || facility.latitude,
//       lng: placeDetails.lng || facility.longitude,
//       photoReferences: placeDetails.photos?.map((photo: any) => photo.photo_reference) || [],
//       reviews: placeDetails.reviews || [],
//       placeId: placeDetails.placeId,
//       lastUpdated: new Date().toISOString(),
//       reviewsLastUpdated: new Date().toISOString()
//     };

//     // Save to Redis
//     await setCache(redisKey, JSON.stringify(cacheData));
    
//     // Save to MongoDB
//     await NursingFacility.findByIdAndUpdate(facility._id, {
//       googleCache: cacheData
//     });

//     console.log(`✅ Refreshed Google data for: ${facility.provider_name}`);
//   } catch (error) {
//     console.error(`❌ Failed to refresh Google data for ${facility._id}:`, error);
//   }
// }

// Temporary: Disable all Google API refreshes
// async function refreshGoogleDataInBackground(facility: any, redisKey: string) {
//   console.log(`⚠️ Google API refresh disabled due to quota limits for: ${facility.provider_name}`);
//   return; // Don't make any API calls
// }

const refreshGoogleDataInBackground = async (facility: any, redisKey: string) => {
  try {
    // Fetch fresh data from Google Places API
    const placeDetails = await googleService.getPlaceDetails(facility.place_id);
    
    if (!placeDetails) {
      throw new Error('No place details found');
    }

    // Prepare the data to cache
    const cacheData = {
      googleName: placeDetails.name,
      rating: placeDetails.rating,
      lat: placeDetails.lat,
      lng: placeDetails.lng,
      photoReferences: placeDetails.photos?.map((photo: any) => photo.photo_reference) || [],
      reviews: placeDetails.reviews || [],
      user_ratings_total: placeDetails.user_ratings_total || null, // Add this
      lastUpdated: new Date().toISOString(),
      reviewsLastUpdated: new Date().toISOString(),
    };

    // Update Redis cache
    await setCache(redisKey, JSON.stringify(cacheData));

    // Update MongoDB cache (optional)
    await Facility.findByIdAndUpdate(facility._id, {
      $set: { googleCache: cacheData }
    });

    // Build photo URLs for immediate return
    const photoUrls = cacheData.photoReferences
      .slice(0, 4)
      .map((ref: string) => googleService.getPhotoUrl(ref));

    return {
      googleName: cacheData.googleName,
      rating: cacheData.rating,
      lat: cacheData.lat,
      lng: cacheData.lng,
      photos: photoUrls,
      reviews: cacheData.reviews,
      user_ratings_total: cacheData.user_ratings_total, // Add this
    };
  } catch (err) {
    console.error(`Background refresh failed for ${facility.provider_name}:`, err);
    throw err;
  }
};

// Fast, non-blocking Google data fetch: returns cached data immediately,
// async function getGoogleDataFast(facility: any) {
//   const REDIS_KEY = `facility:${facility._id}:google`;
//   const now = new Date();

//   try {
//     const redisData = await getCache(REDIS_KEY);
//     if (redisData) {
//       const parsed = JSON.parse(redisData);
//       // Background refresh if needed, but do not block
//       const lastUpdated = new Date(parsed.lastUpdated || 0);
//       const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
//       const reviewsLastUpdated = new Date(parsed.reviewsLastUpdated || parsed.lastUpdated || 0);
//       const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;
//       if (isCoreStale || areReviewsStale) {
//         // fire and forget
//         refreshGoogleDataInBackground(facility, REDIS_KEY);
//       }

//       const photoUrls = (parsed.photoReferences || [])
//         .slice(0, 4)
//         .map((ref: string) => googleService.getPhotoUrl(ref));

//       return {
//         googleName: parsed.googleName ?? null,
//         rating: parsed.rating ?? null,
//         lat: parsed.lat ?? null,
//         lng: parsed.lng ?? null,
//         photos: photoUrls,
//         reviews: parsed.reviews || [],
//         hadCache: true,
//       };
//     }

//     const mongoCache = facility.googleCache;
//     if (mongoCache && mongoCache.lastUpdated) {
//       // store to Redis for next time (non-blocking)
//       setCache(REDIS_KEY, JSON.stringify(mongoCache)).catch(() => {});

//       const photoUrls = (mongoCache.photoReferences || []).slice(0, 4).map((ref: string) => googleService.getPhotoUrl(ref));
//       // background refresh if stale
//       const lastUpdated = new Date(mongoCache.lastUpdated);
//       const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
//       const reviewsLastUpdated = new Date(mongoCache.reviewsLastUpdated || mongoCache.lastUpdated);
//       const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;
//       if (isCoreStale || areReviewsStale) {
//         refreshGoogleDataInBackground(facility, REDIS_KEY);
//       }

//       return {
//         googleName: mongoCache.googleName ?? null,
//         rating: mongoCache.rating ?? null,
//         lat: mongoCache.lat ?? null,
//         lng: mongoCache.lng ?? null,
//         photos: photoUrls,
//         reviews: mongoCache.reviews || [],
//         hadCache: true,
//       };
//     }
//   } catch (e) {
//     // ignore and fallback to background
//   }

//   // Trigger background refresh immediately for first-time users
//   refreshGoogleDataInBackground(facility, REDIS_KEY);

//   // Quick placeholder response
//   return {
//     googleName: null,
//     rating: null,
//     lat: null,
//     lng: null,
//     photos: [],
//     reviews: [],
//     hadCache: false,
//   };
// }


// Complete getGoogleDataFast function
async function getGoogleDataFast(facility: any) {
  const REDIS_KEY = `facility:${facility._id}:google`;
  const now = new Date();

  try {
    const redisData = await getCache(REDIS_KEY);
    if (redisData) {
      const parsed = JSON.parse(redisData);
      // Background refresh if needed, but do not block
      const lastUpdated = new Date(parsed.lastUpdated || 0);
      const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
      const reviewsLastUpdated = new Date(parsed.reviewsLastUpdated || parsed.lastUpdated || 0);
      const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;
      // if (isCoreStale || areReviewsStale) {
      //   // fire and forget
      //   refreshGoogleDataInBackground(facility, REDIS_KEY);
      // }

      const photoUrls = (parsed.photoReferences || [])
        .slice(0, 4)
        .map((ref: string) => `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${ref}&key=${process.env.GOOGLE_API_KEY}`);

      return {
        googleName: parsed.googleName ?? null,
        rating: parsed.rating ?? null,
        lat: parsed.lat ?? null,
        lng: parsed.lng ?? null,
        photos: photoUrls,
        reviews: parsed.reviews || [],
        hadCache: true,
        placeId: parsed.placeId || null,
        photoReferences: parsed.photoReferences || []
      };
    }

    const mongoCache = facility.googleCache;
    if (mongoCache && mongoCache.lastUpdated) {
      // store to Redis for next time (non-blocking)
      setCache(REDIS_KEY, JSON.stringify(mongoCache)).catch(() => {});

      const photoUrls = (mongoCache.photoReferences || []).slice(0, 4).map((ref: string) => 
        `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${ref}&key=${process.env.GOOGLE_API_KEY}`
      );
      
      // background refresh if stale
      const lastUpdated = new Date(mongoCache.lastUpdated);
      const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
      const reviewsLastUpdated = new Date(mongoCache.reviewsLastUpdated || mongoCache.lastUpdated);
      const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;
      // if (isCoreStale || areReviewsStale) {
      //   refreshGoogleDataInBackground(facility, REDIS_KEY);
      // }

      return {
        googleName: mongoCache.googleName ?? null,
        rating: mongoCache.rating ?? null,
        lat: mongoCache.lat ?? null,
        lng: mongoCache.lng ?? null,
        photos: photoUrls,
        reviews: mongoCache.reviews || [],
        hadCache: true,
        placeId: mongoCache.placeId || null,
        photoReferences: mongoCache.photoReferences || []
      };
    }
  } catch (e) {
    // ignore and fallback to background
    console.error('Error in getGoogleDataFast:', e);
  }

  // Trigger background refresh immediately for first-time users
  // refreshGoogleDataInBackground(facility, REDIS_KEY);

  // Quick placeholder response
  return {
    googleName: null,
    rating: null,
    lat: null,
    lng: null,
    photos: [],
    reviews: [],
    hadCache: false,
    placeId: null,
    photoReferences: []
  };
}


// Get Facility Details
export const getFacilityDetails = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name } = req.query as { name?: string };

    if (!name) {
      return res.status(400).json({ message: "Facility name is required." });
    }

    const safeName = name.trim();
    const firstWord = safeName.split(/\s+/)[0];
    const escapedFirstWord = firstWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedFull = safeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Try anchored match on both full name and first word
    let facility = await Facility.findOne({
      $or: [
        { provider_name: { $regex: `^${escapedFull}`, $options: "i" } },
        { legal_business_name: { $regex: `^${escapedFull}`, $options: "i" } },
        { provider_name: { $regex: `^${escapedFirstWord}`, $options: "i" } },
        { legal_business_name: { $regex: `^${escapedFirstWord}`, $options: "i" } },
      ],
    })
      .sort({ provider_name: 1 })
      .lean();

    if (!facility) {
      // Fallback 1: Trimmed field match using $expr to handle stray spaces
      const exprRegex = new RegExp(`^${escapedFirstWord}`, "i");
      const trimmed = await Facility.findOne({
        $or: [
          { $expr: { $regexMatch: { input: { $trim: { input: "$provider_name" } }, regex: exprRegex } } },
          { $expr: { $regexMatch: { input: { $trim: { input: "$legal_business_name" } }, regex: exprRegex } } },
        ],
      })
        .sort({ provider_name: 1 })
        .lean();

      if (trimmed) {
        facility = trimmed;
      } else {
        // Fallback 2: contains search to help catch slight variations
        const fallback = await Facility.findOne({
          $or: [
            { provider_name: { $regex: `${escapedFirstWord}`, $options: "i" } },
            { legal_business_name: { $regex: `${escapedFirstWord}`, $options: "i" } },
          ],
        })
          .sort({ provider_name: 1 })
          .lean();

        if (!fallback) {
          console.log(`[DETAIL DEBUG] No facilities found for name='${safeName}' (full/first-word, anchored; trimmed; contains).`);
          return res.status(404).json({ message: "Facility not found." });
        }

        facility = fallback;
      }
    }

    // ✅ Fetch Google data safely
    const googleData = (await fetchAndCacheGoogleData(facility)) ?? {
      googleName: null,
      rating: null,
      lat: null,
      lng: null,
      photos: [],
      reviews: [],
      user_ratings_total: null,
    };

    // ✅ DEBUG: Log what we're getting from Google
    console.log('🔍 Google Data Debug:', {
      hasUserRatingsTotal: 'user_ratings_total' in googleData,
      user_ratings_total: googleData.user_ratings_total,
      rating: googleData.rating,
      reviewsCount: googleData.reviews?.length,
      photosCount: googleData.photos?.length
    });

    // ✅ Safe default AI summary
    let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] };

    // ✅ Safely extract review text (no TS18047)
    const reviewsText = googleData.reviews?.length
      ? googleData.reviews.map((r: any) => r.text).join("\n")
      : "";

    // ✅ Only summarize if reviews exist
    if (reviewsText) {
      try {
        aiSummary = await summarizeReviews(reviewsText);
      } catch (err) {
        console.error("⚠️ AI Summary failed:", err);
      }
    }

    // ✅ Respond with combined facility + Google data
    const responseData = {
      ...facility,
      googleName: googleData.googleName ?? null,
      rating: googleData.rating ?? null,
      photos: googleData.photos ?? [],
      reviews: googleData.reviews ?? [],
      lat: googleData.lat ?? null,
      lng: googleData.lng ?? null,
      user_ratings_total: googleData.user_ratings_total ?? null,
      aiSummary,
    };

    // ✅ DEBUG: Log final response
    console.log('🔍 Final Response Debug:', {
      hasUserRatingsTotal: 'user_ratings_total' in responseData,
      user_ratings_total: responseData.user_ratings_total
    });

    res.json(responseData);
  } catch (err) {
    console.error("❌ Error in getFacilityDetails:", err);
    next(err);
  }
}; 


// // Get Facility Details
// export const getFacilityDetails = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const { name } = req.query as { name?: string };

//     if (!name) {
//       return res.status(400).json({ message: "Facility name is required." });
//     }

//     const safeName = name.trim();
    
//     // 🗝️ Generate cache key from facility name
//     const cacheKeyParams = { name: safeName };
//     const cacheKey = `facility_details:${JSON.stringify(cacheKeyParams)}`;
//     const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

//     // -----------------------------
//     // 1️⃣ Redis Cache Check
//     // -----------------------------
//     const cachedRedis = await getCache(cacheKey);
//     if (cachedRedis) {
//       const parsed = JSON.parse(cachedRedis);
//       if (!parsed.provider_name) {
//         await deleteCache(cacheKey);
//       } else {
//         console.log("⚡ Serving facility details from Redis cache");
//         return res.status(200).json({ ...parsed, cached: true, from: "redis" });
//       }
//     }

//     // -----------------------------
//     // 2️⃣ Mongo Cache Collection
//     // -----------------------------
//     const mongoCache = await CachedSearchResult.findOne({ key: cacheKey });
//     if (mongoCache) {
//       if (!mongoCache.data?.provider_name) {
//         await CachedSearchResult.deleteOne({ key: cacheKey });
//       } else {
//         console.log("⚡ Serving facility details from MongoDB cache");
//         await setCache(cacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
//         return res
//           .status(200)
//           .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
//       }
//     }

//     console.log("🔄 Cache miss - fetching fresh facility details");

//     const firstWord = safeName.split(/\s+/)[0];
//     const escapedFirstWord = firstWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//     const escapedFull = safeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//     // Try anchored match on both full name and first word
//     let facility = await Facility.findOne({
//       $or: [
//         { provider_name: { $regex: `^${escapedFull}`, $options: "i" } },
//         { legal_business_name: { $regex: `^${escapedFull}`, $options: "i" } },
//         { provider_name: { $regex: `^${escapedFirstWord}`, $options: "i" } },
//         { legal_business_name: { $regex: `^${escapedFirstWord}`, $options: "i" } },
//       ],
//     })
//       .sort({ provider_name: 1 })
//       .lean();

//     if (!facility) {
//       // Fallback 1: Trimmed field match using $expr to handle stray spaces
//       const exprRegex = new RegExp(`^${escapedFirstWord}`, "i");
//       const trimmed = await Facility.findOne({
//         $or: [
//           { $expr: { $regexMatch: { input: { $trim: { input: "$provider_name" } }, regex: exprRegex } } },
//           { $expr: { $regexMatch: { input: { $trim: { input: "$legal_business_name" } }, regex: exprRegex } } },
//         ],
//       })
//         .sort({ provider_name: 1 })
//         .lean();

//       if (trimmed) {
//         facility = trimmed;
//       } else {
//         // Fallback 2: contains search to help catch slight variations
//         const fallback = await Facility.findOne({
//           $or: [
//             { provider_name: { $regex: `${escapedFirstWord}`, $options: "i" } },
//             { legal_business_name: { $regex: `${escapedFirstWord}`, $options: "i" } },
//           ],
//         })
//           .sort({ provider_name: 1 })
//           .lean();

//         if (!fallback) {
//           console.log(`[DETAIL DEBUG] No facilities found for name='${safeName}' (full/first-word, anchored; trimmed; contains).`);
          
//           // Cache the not-found result to avoid repeated DB lookups
//           const notFoundResponse = { 
//             message: "Facility not found.",
//             cached: false,
//             from: "db" 
//           };
          
//           await setCache(cacheKey, JSON.stringify(notFoundResponse), ONE_YEAR_MS);
//           await CachedSearchResult.findOneAndUpdate(
//             { key: cacheKey },
//             { 
//               key: cacheKey,
//               data: notFoundResponse,
//               createdAt: new Date(),
//               expiresAt: new Date(Date.now() + ONE_YEAR_MS)
//             },
//             { upsert: true, new: true }
//           );
          
//           return res.status(404).json(notFoundResponse);
//         }

//         facility = fallback;
//       }
//     }

//     // ✅ Fetch Google data safely
//     const googleData = (await fetchAndCacheGoogleData(facility)) ?? {
//       googleName: null,
//       rating: null,
//       lat: null,
//       lng: null,
//       photos: [],
//       reviews: [],
//       user_ratings_total: null,
//     };

//     // ✅ DEBUG: Log what we're getting from Google
//     console.log('🔍 Google Data Debug:', {
//       hasUserRatingsTotal: 'user_ratings_total' in googleData,
//       user_ratings_total: googleData.user_ratings_total,
//       rating: googleData.rating,
//       reviewsCount: googleData.reviews?.length,
//       photosCount: googleData.photos?.length
//     });

//     // ✅ Safe default AI summary
//     let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] };

//     // ✅ Safely extract review text (no TS18047)
//     const reviewsText = googleData.reviews?.length
//       ? googleData.reviews.map((r: any) => r.text).join("\n")
//       : "";

//     // ✅ Only summarize if reviews exist
//     if (reviewsText) {
//       try {
//         aiSummary = await summarizeReviews(reviewsText);
//       } catch (err) {
//         console.error("⚠️ AI Summary failed:", err);
//       }
//     }

//     // ✅ Build response data
//     const responseData = {
//       ...facility,
//       googleName: googleData.googleName ?? null,
//       rating: googleData.rating ?? null,
//       photos: googleData.photos ?? [],
//       reviews: googleData.reviews ?? [],
//       lat: googleData.lat ?? null,
//       lng: googleData.lng ?? null,
//       user_ratings_total: googleData.user_ratings_total ?? null,
//       aiSummary,
//     };

//     // ✅ DEBUG: Log final response
//     console.log('🔍 Final Response Debug:', {
//       hasUserRatingsTotal: 'user_ratings_total' in responseData,
//       user_ratings_total: responseData.user_ratings_total
//     });

//     // -----------------------------
//     // 💾 CACHE THE RESULTS
//     // -----------------------------
//     try {
//       // Cache in Redis
//       await setCache(cacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
      
//       // Cache in MongoDB
//       await CachedSearchResult.findOneAndUpdate(
//         { key: cacheKey },
//         { 
//           key: cacheKey,
//           data: responseData,
//           createdAt: new Date(),
//           expiresAt: new Date(Date.now() + ONE_YEAR_MS)
//         },
//         { upsert: true, new: true }
//       );
      
//       console.log(`💾 Cached facility details for key: ${cacheKey}`);
//     } catch (cacheError) {
//       console.error("❌ Failed to cache facility details:", cacheError);
//       // Don't fail the request if caching fails
//     }

//     // ✅ RETURN RESPONSE
//     return res.status(200).json({
//       ...responseData,
//       cached: false,
//       from: "db+google+ai"
//     });
//   } catch (err) {
//     console.error("❌ Error in getFacilityDetails:", err);
//     next(err);
//   }
// };

// ✅ Get Top 10 Highest Rated Nursing Facilities (for Home Page)
export const getTop10Facilities = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const cacheKey = "top10:facilities";

    // 1️⃣ Try Redis cache
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res
        .status(200)
        .json({ data: JSON.parse(cachedData), cached: true, from: "redis" });
    }

    // 2️⃣ Fetch top 10 facilities by rating from allowed states
    const facilities = await NursingFacility.find({
      state: { $in: ["NY", "NJ", "CT", "PA"] },
    })
      .sort({ rating: -1 })
      .limit(10)
      .lean();

    if (!facilities.length) {
      return res.status(200).json({ data: [], message: "No facilities found" });
    }

    // 3️⃣ Fetch Google data (photo, rating, coordinates)
    const enrichedFacilities = await Promise.all(
      facilities.map(async (f) => {
        try {
          const gd = await getGoogleDataFast(f);

          // ✅ Save Google data in your DB if photo exists
          if (gd?.photos?.[0]) {
            await NursingFacility.updateOne(
              { _id: f._id },
              {
                $set: {
                  googleName: gd.googleName || f.provider_name,
                  googlePhoto: gd.photos?.[0],
                  googleRating: gd.rating || f.rating,
                  googleLat: gd.lat,
                  googleLng: gd.lng,
                },
              }
            );
          }

          return {
            ...f,
            googleName: gd.googleName ?? f.provider_name,
            rating: gd.rating ?? f.rating ?? null,
            photo: gd.photos?.[0] || null,
            lat: gd.lat ?? null,
            lng: gd.lng ?? null,
          };
        } catch (err: any) {
          console.error(`Google fetch failed for ${f.provider_name}:`, err.message);
          return f; // fallback to original
        }
      })
    );

    // 4️⃣ Cache for 24 hours
    await setCache(cacheKey, JSON.stringify(enrichedFacilities), 86400 * 1000);

    return res.status(200).json({
      data: enrichedFacilities,
      total: enrichedFacilities.length,
      from: "db",
    });
  } catch (err: any) {
    console.error("❌ getTop10Facilities Error:", err);
    res.status(500).json({ error: err.message });
  }
};
// Add this new function to your existing controller
export const getAllFacilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Build query - only filter by allowed states
    let query: any = {};

    // Only include facilities from allowed states
    const allowedStates = ["NY", "NJ", "CT", "PA"];
    query.state = { $in: allowedStates };

    // Get all facilities without any search filters
    const facilities = await NursingFacility.find(query)
      .select('provider_name city_town state zip_code provider_address telephone_number cms_certification_number_ccn')
      .sort({ provider_name: 1 })
      .lean();

    // Get total count
    const totalCount = await NursingFacility.countDocuments(query);

    res.status(200).json({
      success: true,
      facilities,
      totalCount,
      message: `Found ${totalCount} facilities from ${allowedStates.join(', ')}`
    });

  } catch (error) {
    console.error('❌ Get all facilities error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch facilities',
      facilities: []
    });
  }
};


// ✅ Map of states (Full Name → Abbreviation)
// const stateToAbbr: Record<string, string> = {
//   "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
//   "Colorado": "CO", "Connecticut": "CT", "Delware": "DE", "Florida": "FL", "Georgia": "GA",
//   "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
//   "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
//   "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
//   "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
//   "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
//   "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
//   "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
//   "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
//   "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"
// };

// ✅ Allowed states
const allowedStates = ["New York", "New Jersey", "Connecticut", "Pennsylvania"];
const allowedAbbr = ["NY", "NJ", "CT", "PA"];
const stateToAbbr: Record<string, string> = {
"New York": "NY",
"New Jersey": "NJ",
"Connecticut": "CT",
"Pennsylvania": "PA",
};


// function normalizeQuery(q: string): { type: "zip" | "state" | "city"; value: string } {
//   const cleanQ = q.trim().toLowerCase();
//   const zipRegex = /^\d{5}$/;

//   if (zipRegex.test(cleanQ)) return { type: "zip", value: cleanQ };

//   const stateMatch = Object.keys(stateToAbbr).find(
//     (state) => state.toLowerCase() === cleanQ || state.toLowerCase().startsWith(cleanQ)
//   );

//   if (stateMatch) return { type: "state", value: stateToAbbr[stateMatch] };

//   return { type: "city", value: q };
// }

// Helper function to normalize search queries - COMPLETE FIXED VERSION
// function normalizeQuery(query: string): { type: 'zip' | 'city' | 'state' | 'other'; value: string } {
//   const trimmed = query.trim().toLowerCase();
  
//   // Check for ZIP code (5 digits)
//   const zipMatch = trimmed.match(/^\d{5}$/);
//   if (zipMatch) return { type: 'zip', value: trimmed };
  
//   // Check for state names and abbreviations
//   const stateMap: Record<string, string> = {
//     "new york": "NY",
//     "new jersey": "NJ", 
//     "connecticut": "CT",
//     "pennsylvania": "PA",
//     "ny": "NY",
//     "nj": "NJ",
//     "ct": "CT", 
//     "pa": "PA"
//   };
  
//   const normalizedState = stateMap[trimmed];
//   if (normalizedState) {
//     return { type: 'state', value: normalizedState };
//   }
  
//   // Check for partial state matches (like "new york" in "new_york_city")
//   for (const [stateName, abbr] of Object.entries(stateMap)) {
//     if (trimmed.includes(stateName)) {
//       return { type: 'state', value: abbr };
//     }
//   }
  
//   // Check for city (simple heuristic)
//   if (trimmed.length > 2 && /^[a-zA-z\s]+$/.test(trimmed.replace(/_/g, ' '))) {
//     return { type: 'city', value: trimmed.replace(/_/g, ' ') };
//   }
  
//   return { type: 'other', value: trimmed.replace(/_/g, ' ') };
// }

// FIXED normalizeQuery function
const normalizeQuery = (query: string): { type: string; value: string } => {
  const trimmed = query.trim();
  
  console.log(`🔍 Normalizing query: "${query}" -> "${trimmed}"`);
  
  // Check if it's a ZIP code (5 digits)
  if (/^\d{5}$/.test(trimmed)) {
    return { type: "zip", value: trimmed };
  }
  
  // Check if it's a state name or abbreviation (case insensitive)
  const stateMap: Record<string, string> = {
    "new york": "New York", 
    "ny": "New York",
    "new jersey": "New Jersey", 
    "nj": "New Jersey", 
    "connecticut": "Connecticut", 
    "ct": "Connecticut",
    "pennsylvania": "Pennsylvania", 
    "pa": "Pennsylvania"
  };
  
  const lowerTrimmed = trimmed.toLowerCase();
  if (stateMap[lowerTrimmed]) {
    console.log(`📍 Detected state query: "${trimmed}" -> "${stateMap[lowerTrimmed]}"`);
    return { type: "state", value: stateMap[lowerTrimmed] };
  }
  
  // Assume it's a city name
  console.log(`🏙️ Assuming city query: "${trimmed}"`);
  return { type: "city", value: trimmed };
};
type FacilityType = any; 


// // Main search function
// export const searchFacilitiesWithReviews = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const { lat, lng, q, page = "1", limit = "8" } = req.query as {
//       lat?: string;
//       lng?: string;
//       q?: string;
//       page?: string;
//       limit?: string;
//     };

//     const pageNum = parseInt(page);
//     const limitNum = parseInt(limit);

//     const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
//     const pageCacheKey = `${baseCacheKey}&page:${pageNum}`;

//     console.log('🔍 Search parameters:', { q, page: pageNum, limit: limitNum, cacheKey: pageCacheKey });

//     // -----------------------------
//     // 1️⃣ Redis Cache
//     // -----------------------------
//     const cachedRedis = await getCache(pageCacheKey);
//     if (cachedRedis) {
//       const parsed = JSON.parse(cachedRedis);
//       if (!parsed.data?.length) {
//         await deleteCache(pageCacheKey);
//       } else {
//         console.log('⚡ Serving from Redis cache');
//         return res.status(200).json({ ...parsed, cached: true, from: "redis" });
//       }
//     }

//     // -----------------------------
//     // 2️⃣ Mongo Cache Collection
//     // -----------------------------
//     const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
//     if (mongoCache) {
//       if (!mongoCache.data?.data?.length) {
//         await CachedSearchResult.deleteOne({ key: pageCacheKey });
//       } else {
//         console.log('🗄️ Serving from MongoDB cache');
//         await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
//         return res
//           .status(200)
//           .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
//       }
//     }

//     const allowedStates = ["New York", "New Jersey", "Connecticut", "Pennsylvania"];
//     const allowedAbbr = ["NY", "NJ", "CT", "PA"];
//     const stateToAbbr: Record<string, string> = {
//       "New York": "NY",
//       "New Jersey": "NJ",
//       "Connecticut": "CT",
//       "Pennsylvania": "PA",
//     };

//     // -----------------------------
//     // 3️⃣ Query Main Database
//     // -----------------------------
//     let mongoQuery: any = {};
//     let facilities: any[] = [];
//     let totalCount = 0;

//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);

//       const pipeline: PipelineStage[] = [
//         {
//           $geoNear: {
//             near: { type: "Point", coordinates: [longitude, latitude] },
//             distanceField: "distance_m",
//             distanceMultiplier: 0.001,
//             maxDistance: 50000,
//             spherical: true,
//           },
//         },
//         {
//           $match: {
//             state: { $in: allowedAbbr },
//           },
//         },
//         {
//           $skip: (pageNum - 1) * limitNum,
//         },
//         {
//           $limit: limitNum,
//         },
//       ];

//       facilities = await NursingFacility.aggregate(pipeline);
      
//       const totalPipeline: PipelineStage[] = [
//         {
//           $geoNear: {
//             near: { type: "Point", coordinates: [longitude, latitude] },
//             distanceField: "distance_m",
//             maxDistance: 50000,
//             spherical: true,
//           },
//         },
//         {
//           $match: {
//             state: { $in: allowedAbbr },
//           },
//         },
//         {
//           $count: "total"
//         }
//       ];
      
//       const totalResult = await NursingFacility.aggregate(totalPipeline);
//       totalCount = totalResult[0]?.total || 0;

//     } else if (q) {
//       // Text-based search
//       const cleanedQuery = q.replace(/_/g, " ").trim();
//       const { type, value } = normalizeQuery(cleanedQuery);

//       if (type === "zip") {
//         const zipNumber = parseInt(value, 10);
//         if (isNaN(zipNumber)) {
//           return res.status(400).json({ error: `Invalid ZIP code "${value}".` });
//         }

//         const normalizedZip = zipNumber.toString().padStart(5, "0");
//         console.log("ZIP search:", normalizedZip);

//         let zipTotal = await NursingFacility.countDocuments({ zip_code: normalizedZip });
//         console.log("ZIP count:", zipTotal);
        
//         if (zipTotal > 0) {
//           const facilityZip = await NursingFacility.findOne({ zip_code: normalizedZip }).select("state").lean();
//           console.log("Facility ZIP state:", facilityZip?.state);

//           const zipStateNormalized = facilityZip?.state?.trim().toUpperCase() || null;
//           if (!zipStateNormalized || !allowedAbbr.includes(zipStateNormalized)) {
//             return res.status(400).json({
//               error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//             });
//           }

//           mongoQuery = { zip_code: normalizedZip, state: zipStateNormalized };
//           facilities = await NursingFacility.find(mongoQuery)
//             .skip((pageNum - 1) * limitNum)
//             .limit(limitNum)
//             .lean();

//           totalCount = await NursingFacility.countDocuments(mongoQuery);

//         } else {
//           try {
//             const placeName = `${normalizedZip}, USA`;
//             const { lat, lng } = await getCoordinatesByPlaceName(placeName);
//             console.log("Google Coordinates:", { lng, lat });
            
//             facilities = await NursingFacility.find({
//               geoLocation: {
//                 $near: {
//                   $geometry: { type: "Point", coordinates: [lng, lat] },
//                   $maxDistance: 50000,
//                 },
//               },
//               state: { $in: allowedAbbr },
//             })
//               .limit(limitNum)
//               .lean();
              
//             console.log("Found nearby facilities:", facilities.length);
//             totalCount = facilities.length;

//             const responseData = {
//               message: `ZIP code "${normalizedZip}" not found in database. Showing nearby facilities.`,
//               coordinates: { lat, lng },
//               total: totalCount,
//               facilities: facilities,
//               page: pageNum,
//               limit: limitNum,
//               cached: false,
//               from: "db",
//             };

//             if (facilities.length) {
//               await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
//               await CachedSearchResult.updateOne(
//                 { key: pageCacheKey },
//                 { $set: { data: responseData } },
//                 { upsert: true }
//               );
//             }

//             return res.json(responseData);
//           } catch (err: any) {
//             console.error("Google Geocode Error:", err.message);
//             return res.status(400).json({
//               error: `ZIP code "${normalizedZip}" not found in our database and Google lookup failed: ${err.message}`,
//             });
//           }
//         }
//       } else if (type === "state") {
//         const abbr = stateToAbbr[value] || value.toUpperCase();
//         if (!allowedAbbr.includes(abbr)) {
//           return res.status(400).json({
//             error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//           });
//         }

//         mongoQuery = { state: abbr };
//         totalCount = await NursingFacility.countDocuments(mongoQuery);
//         facilities = await NursingFacility.find(mongoQuery)
//           .skip((pageNum - 1) * limitNum)
//           .limit(limitNum)
//           .lean();
//       } else if (type === "city") {
//         const facilityInCity = await NursingFacility.findOne({ 
//           city_town: new RegExp(`^${value}$`, "i") 
//         })
//           .select("state")
//           .lean();

//         if (!facilityInCity || !allowedAbbr.includes(facilityInCity.state ?? "")) {
//           return res.status(400).json({
//             error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//           });
//         }

//         mongoQuery = { city_town: new RegExp(`^${value}$`, "i") };
//         totalCount = await NursingFacility.countDocuments(mongoQuery);
//         facilities = await NursingFacility.find(mongoQuery)
//           .skip((pageNum - 1) * limitNum)
//           .limit(limitNum)
//           .lean();
//       } else {
//         mongoQuery = {
//           $or: [
//             { city_town: new RegExp(value, "i") },
//             { provider_name: new RegExp(value, "i") },
//             { zip_code: new RegExp(value, "i") },
//           ],
//           state: { $in: allowedAbbr },
//         };

//         totalCount = await NursingFacility.countDocuments(mongoQuery);
//         facilities = await NursingFacility.find(mongoQuery)
//           .skip((pageNum - 1) * limitNum)
//           .limit(limitNum)
//           .lean();
//       }
//     }

//     // -----------------------------
//     // 4️⃣ Empty Result Handling
//     // -----------------------------
//     if (!facilities.length) {
//       await deleteCache(pageCacheKey);
//       await CachedSearchResult.deleteOne({ key: pageCacheKey });

//       return res.status(200).json({
//         data: [],
//         total: 0,
//         page: pageNum,
//         limit: limitNum,
//         cached: false,
//         from: "db",
//       });
//     }

//     console.log(`🏥 Found ${facilities.length} facilities from database`);
 
//     // -----------------------------
//     // 5️⃣ Google + AI Enrichment
//     // -----------------------------
//     console.log('🔍 Fetching Google data...');
//     const googleResults = await Promise.all(
//       facilities.map((f) => getGoogleDataFast(f))
//     );
    
//     const reviewsTexts = facilities.map((_: any, i: number) =>
//       googleResults[i]?.reviews?.length
//         ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//         : ""
//     );
    
//     console.log('🤖 Generating AI summaries...');
//     const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//     // -----------------------------
//     // 🖼️ 6️⃣ Image Caching Integration
//     // -----------------------------
//     console.log('🖼️ Starting image caching...');
//     const facilitiesWithCachedPhotos = await Promise.all(
//       facilities.map(async (f: any, i: number) => {
//         const gd = googleResults[i] ?? {};
        
//         // ✅ Use photoReferences from the Google data result
//         const photoRefs = gd.photoReferences || [];
        
//         console.log(`🖼️ Facility ${f._id}:`, {
//           hasGoogleData: !!gd,
//           photoRefsCount: photoRefs.length,
//           placeId: gd.placeId,
//           googleName: gd.googleName
//         });

//         // Get cached photo URLs for this facility
//         let cachedPhotoUrls: string[] = [];
        
//         if (photoRefs.length > 0) {
//           try {
//             console.log(`  📸 Processing ${photoRefs.length} photo references for facility ${f._id}`);
            
//             cachedPhotoUrls = await Promise.all(
//               photoRefs.slice(0, 4).map(async (photoRef: string, index: number) => {
//                 console.log(`    🔄 Caching photo ${index + 1}: ${photoRef.substring(0, 20)}...`);
//                 const url = await getCachedPhotoUrl(
//                   photoRef, 
//                   600, 
//                   f._id?.toString(), 
//                   gd.placeId
//                 );
//                 console.log(`    ✅ Photo ${index + 1}: ${url ? 'CACHED' : 'FAILED'}`);
//                 return url;
//               })
//             );
            
//             // Filter out null values
//             cachedPhotoUrls = cachedPhotoUrls.filter(url => url !== null) as string[];
//             console.log(`  🎉 Successfully cached ${cachedPhotoUrls.length}/${photoRefs.length} photos`);
//           } catch (error) {
//             console.error(`❌ Error caching photos for facility ${f._id}:`, error);
//           }
//         } else {
//           console.log(`  ℹ️ No photo references found for facility ${f._id}`);
//           // If no photo references, use the direct photo URLs from Google
//           cachedPhotoUrls = gd.photos || [];
//         }

//         return {
//           ...f,
//           googleName: gd.googleName ?? null,
//           rating: gd.rating ?? null,
//           photos: cachedPhotoUrls, // Cached photo URLs (our local cached versions)
//           photoRefs: photoRefs, // Original Google photo references
//           lat: gd.lat ?? f.latitude ?? null,
//           lng: gd.lng ?? f.longitude ?? null,
//           aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//           googlePlaceId: gd.placeId || null,
//         };
//       })
//     );

//     // -----------------------------
//     // 7️⃣ Batch Cache Photos for Next Requests (Non-blocking)
//     // -----------------------------
//     if (pageNum <= 3) {
//       const facilitiesForBatchCache = facilities.map((f: any, i: number) => {
//         const gd = googleResults[i] ?? {};
//         return {
//           id: f._id?.toString(),
//           photoRefs: gd.photoReferences || [],
//           googlePlaceId: gd.placeId
//         };
//       }).filter(f => f.photoRefs.length > 0);

//       if (facilitiesForBatchCache.length > 0) {
//         console.log(`🔄 Background caching ${facilitiesForBatchCache.length} facilities`);
//         batchCacheFacilityPhotos(facilitiesForBatchCache, 600)
//           .then(results => {
//             const totalCached = Array.from(results.values()).flat().length;
//             console.log(`✅ Background cached ${totalCached} photos for ${results.size} facilities`);
//           })
//           .catch(error => {
//             console.error('❌ Background photo caching error:', error);
//           });
//       }
//     }

//     const totalCachedPhotos = facilitiesWithCachedPhotos.reduce((count, facility) => count + facility.photos.length, 0);
//     const totalPhotoRefs = facilitiesWithCachedPhotos.reduce((count, facility) => count + facility.photoRefs.length, 0);

//     const responseData = {
//       data: facilitiesWithCachedPhotos,
//       total: totalCount,
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: pageNum <= 6 ? "db" : "db+google+ai",
//       imageCacheInfo: {
//         cachedPhotos: totalCachedPhotos,
//         totalPhotoRefs: totalPhotoRefs,
//         cacheRate: totalPhotoRefs > 0 ? ((totalCachedPhotos / totalPhotoRefs) * 100).toFixed(1) + '%' : '0%'
//       }
//     };

//     console.log(`📊 Final stats: ${totalCachedPhotos}/${totalPhotoRefs} photos cached (${responseData.imageCacheInfo.cacheRate})`);

//     // -----------------------------
//     // 8️⃣ Cache Non-Empty Results
//     // -----------------------------
//     if (responseData.data.length) {
//       console.log(`💾 Caching results to Redis and MongoDB`);
//       await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
//       await CachedSearchResult.updateOne(
//         { key: pageCacheKey },
//         { $set: { data: responseData } },
//         { upsert: true }
//       );
//     }

//     return res.status(200).json(responseData);
//   } catch (err: any) {
//     console.error("❌ API error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };
// Main search function
export const searchFacilitiesWithReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { lat, lng, q, page = "1", limit = "8" } = req.query as {
      lat?: string;
      lng?: string;
      q?: string;
      page?: string;
      limit?: string;
    };

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
    const pageCacheKey = `${baseCacheKey}&page:${pageNum}`;

    console.log('🔍 Search parameters:', { q, page: pageNum, limit: limitNum, cacheKey: pageCacheKey });

    // -----------------------------
    // 1️⃣ Redis Cache - WITH SPONSORED VALIDATION
    // -----------------------------
    const cachedRedis = await getCache(pageCacheKey);
    if (cachedRedis) {
      let parsed = JSON.parse(cachedRedis);
      
      if (!parsed.data?.length) {
        await deleteCache(pageCacheKey);
      } else {
        console.log('⚡ Serving from Redis cache - validating sponsored facilities...');
        
        // Validate and update sponsored facilities in cached response
        const validatedResponse = await validateAndUpdateSponsoredFacilities(parsed, q, lat, lng);
        
        if (validatedResponse.updated) {
          console.log('🔄 Updated sponsored facilities in cached response');
          // Update cache with validated response
          await setCache(pageCacheKey, JSON.stringify(validatedResponse.data), ONE_YEAR_MS);
          await CachedSearchResult.updateOne(
            { key: pageCacheKey },
            { $set: { data: validatedResponse.data } },
            { upsert: true }
          );
        }
        
        return res.status(200).json({ ...validatedResponse.data, cached: true, from: "redis", sponsoredValidated: validatedResponse.updated });
      }
    }

    // -----------------------------
    // 2️⃣ Mongo Cache Collection - WITH SPONSORED VALIDATION
    // -----------------------------
    const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
    if (mongoCache) {
      if (!mongoCache.data?.data?.length) {
        await CachedSearchResult.deleteOne({ key: pageCacheKey });
      } else {
        console.log('🗄️ Serving from MongoDB cache - validating sponsored facilities...');
        
        // Validate and update sponsored facilities in cached response
        const validatedResponse = await validateAndUpdateSponsoredFacilities(mongoCache.data, q, lat, lng);
        
        if (validatedResponse.updated) {
          console.log('🔄 Updated sponsored facilities in cached response');
          // Update cache with validated response
          await setCache(pageCacheKey, JSON.stringify(validatedResponse.data), ONE_YEAR_MS);
          await CachedSearchResult.updateOne(
            { key: pageCacheKey },
            { $set: { data: validatedResponse.data } },
            { upsert: true }
          );
        }
        
        return res.status(200).json({ ...validatedResponse.data, cached: true, from: "mongo-cache", sponsoredValidated: validatedResponse.updated });
      }
    }

    const allowedStates = ["New York", "New Jersey", "Connecticut", "Pennsylvania"];
    const allowedAbbr = ["NY", "NJ", "CT", "PA"];
    const stateToAbbr: Record<string, string> = {
      "New York": "NY",
      "New Jersey": "NJ",
      "Connecticut": "CT",
      "Pennsylvania": "PA",
    };
    
    const abbrToState: Record<string, string> = {
      "NY": "New York",
      "NJ": "New Jersey", 
      "CT": "Connecticut",
      "PA": "Pennsylvania"
    };

    // -----------------------------
    // 🔥 GET ALL ACTIVE SPONSORED FACILITIES FIRST
    // -----------------------------
    console.log('🌟 Fetching ALL active sponsored facilities...');
    
    const allActiveSponsored = await SponsoredFacility.find({
      isActive: true,
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() }
    })
      .populate('facility')
      .lean();

    console.log(`🌟 Found ${allActiveSponsored.length} total active sponsored facilities`);

    // Enhanced debugging of sponsored facilities
    console.log('🔍 DEBUG: All active sponsored facilities details:');
    allActiveSponsored.forEach((sponsored: any, index: number) => {
      const facility = sponsored.facility;
      if (facility) {
        console.log(`   ${index + 1}. ${facility.provider_name}`);
        console.log(`      State: "${facility.state}"`);
        console.log(`      City: "${facility.city_town}"`);
        console.log(`      ZIP: "${facility.zip_code}"`);
        console.log(`      Facility ID: ${facility._id}`);
      } else {
        console.log(`   ${index + 1}. ❌ NO FACILITY DATA`);
      }
    });

    interface PopulatedFacility {
      _id: mongoose.Types.ObjectId;
      provider_name: string;
      city_town: string;
      state: string;
      zip_code: string;
      geoLocation?: {
        type: string;
        coordinates: [number, number];
      };
      latitude?: number;
      longitude?: number;
      [key: string]: any;
    }

    interface PopulatedSponsoredFacility {
      _id: mongoose.Types.ObjectId;
      facility: PopulatedFacility;
      priority: number;
      startDate: Date;
      endDate: Date;
      sponsoredBy?: any;
      [key: string]: any;
    }

    const populatedSponsoredFacilities = allActiveSponsored as unknown as PopulatedSponsoredFacility[];

    // -----------------------------
    // 🔍 FIXED: FILTER SPONSORED FACILITIES BASED ON SEARCH CRITERIA
    // -----------------------------
    let matchingSponsoredFacilities: PopulatedSponsoredFacility[] = [];

    if (q) {
      const cleanedQuery = q.replace(/_/g, " ").trim();
      const { type, value } = normalizeQuery(cleanedQuery);

      console.log(`🎯 Filtering sponsored facilities for search: ${type} - "${value}"`);

      matchingSponsoredFacilities = populatedSponsoredFacilities.filter(sponsored => {
        if (!sponsored.facility) {
          console.log('   ❌ Sponsored facility has no populated facility data');
          return false;
        }

        const facility = sponsored.facility;
        
        if (type === "state") {
          // Handle both full state names and abbreviations
          const searchState = value.toLowerCase();
          const facilityState = facility.state?.toLowerCase() || '';
          
          // Multiple matching strategies
          const matches = 
            // Exact state name match
            facilityState === searchState ||
            // State abbreviation match
            facilityState === stateToAbbr[value]?.toLowerCase() ||
            // Reverse lookup: if facility has abbreviation, check full name
            abbrToState[facility.state]?.toLowerCase() === searchState ||
            // Direct abbreviation match
            facility.state?.toUpperCase() === value.toUpperCase();
          
          if (matches) {
            console.log(`   ✅ STATE MATCH: ${facility.provider_name} in ${facility.state}`);
          } else {
            console.log(`   ❌ STATE NO MATCH: ${facility.provider_name} (${facility.state}) vs search (${value})`);
          }
          return matches;
        } 
        else if (type === "zip") {
          const normalizedZip = value.padStart(5, "0");
          const matches = facility.zip_code === normalizedZip;
          if (matches) {
            console.log(`   ✅ ZIP MATCH: ${facility.provider_name} in ${facility.zip_code}`);
          } else {
            console.log(`   ❌ ZIP NO MATCH: ${facility.provider_name} (${facility.zip_code}) vs search (${normalizedZip})`);
          }
          return matches;
        }
        else if (type === "city") {
          const facilityCity = facility.city_town?.toLowerCase() || '';
          const searchCity = value.toLowerCase();
          const matches = facilityCity.includes(searchCity);
          if (matches) {
            console.log(`   ✅ CITY MATCH: ${facility.provider_name} in ${facility.city_town}`);
          } else {
            console.log(`   ❌ CITY NO MATCH: ${facility.provider_name} (${facility.city_town}) vs search (${value})`);
          }
          return matches;
        }
        else {
          // General search - match name, city, or zip
          const searchTerm = value.toLowerCase();
          const facilityName = facility.provider_name?.toLowerCase() || '';
          const facilityCity = facility.city_town?.toLowerCase() || '';
          const facilityZip = facility.zip_code || '';
          
          const matches = 
            facilityName.includes(searchTerm) ||
            facilityCity.includes(searchTerm) || 
            facilityZip.includes(searchTerm);
          
          if (matches) {
            console.log(`   ✅ GENERAL MATCH: ${facility.provider_name}`);
          } else {
            console.log(`   ❌ GENERAL NO MATCH: ${facility.provider_name}`);
          }
          return matches;
        }
      });
    } 
    else if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);
      
      console.log(`📍 Filtering sponsored facilities by geo location: ${latitude}, ${longitude}`);
      
      matchingSponsoredFacilities = populatedSponsoredFacilities.filter(sponsored => {
        const facility = sponsored.facility;
        if (!facility) return false;
        
        let facilityLat: number, facilityLng: number;
        
        // Check if we have geoLocation coordinates
        if (facility.geoLocation?.coordinates) {
          [facilityLng, facilityLat] = facility.geoLocation.coordinates;
        } 
        // Fallback to latitude/longitude fields
        else if (facility.latitude && facility.longitude) {
          facilityLat = facility.latitude;
          facilityLng = facility.longitude;
        } else {
          console.log(`   ❌ GEO NO COORDS: ${facility.provider_name}`);
          return false;
        }
        
        const distance = calculateDistance(latitude, longitude, facilityLat, facilityLng);
        const isWithinRadius = distance <= 50;
        
        if (isWithinRadius) {
          console.log(`   ✅ GEO MATCH: ${facility.provider_name} within ${distance.toFixed(2)}km`);
        } else {
          console.log(`   ❌ GEO NO MATCH: ${facility.provider_name} too far (${distance.toFixed(2)}km)`);
        }
        return isWithinRadius;
      });
    }

    console.log(`🎯 Found ${matchingSponsoredFacilities.length} sponsored facilities matching search criteria`);

    // Log matched sponsored facilities in detail
    if (matchingSponsoredFacilities.length > 0) {
      console.log('🏆 MATCHED SPONSORED FACILITIES:');
      matchingSponsoredFacilities.forEach((sponsored, index) => {
        const facility = sponsored.facility;
        console.log(`   ${index + 1}. ${facility.provider_name}`);
        console.log(`      📍 ${facility.city_town}, ${facility.state} ${facility.zip_code}`);
        console.log(`      ⭐ Priority: ${sponsored.priority}`);
        console.log(`      🆔 Facility ID: ${facility._id}`);
        console.log(`      🆔 Sponsored ID: ${sponsored._id}`);
      });
    } else {
      console.log('❌ NO SPONSORED FACILITIES MATCHED THE SEARCH CRITERIA');
    }

    // Create sponsored facilities IDs for exclusion
    const validSponsoredIds: string[] = matchingSponsoredFacilities
      .map(sponsored => sponsored.facility._id.toString())
      .filter(id => id);

    console.log(`📋 Sponsored facility IDs to exclude from main query: ${validSponsoredIds.length}`, validSponsoredIds);

    // -----------------------------
    // 3️⃣ QUERY MAIN DATABASE (Exclude sponsored facilities to avoid duplicates)
    // -----------------------------
    let mongoQuery: any = {};
    let facilities: any[] = [];
    let totalCount = 0;

    // Base query excludes already included sponsored facilities
    const baseExcludeQuery = validSponsoredIds.length > 0 ? 
      { _id: { $nin: validSponsoredIds.map(id => new mongoose.Types.ObjectId(id)) } } : 
      {};

    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      console.log(`🗺️ Performing geo search around ${latitude}, ${longitude}`);

      const pipeline: PipelineStage[] = [
        {
          $geoNear: {
            near: { type: "Point", coordinates: [longitude, latitude] },
            distanceField: "distance_m",
            distanceMultiplier: 0.001,
            maxDistance: 50000,
            spherical: true,
          },
        },
        {
          $match: {
            state: { $in: allowedAbbr },
            ...baseExcludeQuery
          },
        },
        {
          $skip: (pageNum - 1) * limitNum,
        },
        {
          $limit: limitNum,
        },
      ];

      facilities = await NursingFacility.aggregate(pipeline);
      
      const totalPipeline: PipelineStage[] = [
        {
          $geoNear: {
            near: { type: "Point", coordinates: [longitude, latitude] },
            distanceField: "distance_m",
            maxDistance: 50000,
            spherical: true,
          },
        },
        {
          $match: {
            state: { $in: allowedAbbr },
            ...baseExcludeQuery
          },
        },
        {
          $count: "total"
        }
      ];
      
      const totalResult = await NursingFacility.aggregate(totalPipeline);
      totalCount = totalResult[0]?.total || 0;

      console.log(`🗺️ Found ${facilities.length} regular facilities via geo search (total: ${totalCount})`);

    } else if (q) {
      // Text-based search
      const cleanedQuery = q.replace(/_/g, " ").trim();
      const { type, value } = normalizeQuery(cleanedQuery);

      console.log(`🔍 Performing text search - type: ${type}, value: ${value}`);

      if (type === "zip") {
        const zipNumber = parseInt(value, 10);
        if (isNaN(zipNumber)) {
          return res.status(400).json({ error: `Invalid ZIP code "${value}".` });
        }

        const normalizedZip = zipNumber.toString().padStart(5, "0");
        console.log("📮 ZIP search:", normalizedZip);

        let zipTotal = await NursingFacility.countDocuments({ 
          zip_code: normalizedZip,
          ...baseExcludeQuery
        });
        
        if (zipTotal > 0) {
          const facilityZip = await NursingFacility.findOne({ zip_code: normalizedZip }).select("state").lean();
          const zipStateNormalized = facilityZip?.state?.trim().toUpperCase() || null;
          
          if (!zipStateNormalized || !allowedAbbr.includes(zipStateNormalized)) {
            return res.status(400).json({
              error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
            });
          }

          mongoQuery = { 
            zip_code: normalizedZip, 
            state: zipStateNormalized,
            ...baseExcludeQuery
          };
          facilities = await NursingFacility.find(mongoQuery)
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean();

          totalCount = await NursingFacility.countDocuments(mongoQuery);
          console.log(`📮 Found ${facilities.length} regular facilities in ZIP ${normalizedZip}`);

        } else {
          // Handle ZIP not found with Google fallback
          try {
            const placeName = `${normalizedZip}, USA`;
            const { lat, lng } = await getCoordinatesByPlaceName(placeName);
            
            facilities = await NursingFacility.find({
              geoLocation: {
                $near: {
                  $geometry: { type: "Point", coordinates: [lng, lat] },
                  $maxDistance: 50000,
                },
              },
              state: { $in: allowedAbbr },
              ...baseExcludeQuery
            })
              .limit(limitNum)
              .lean();
              
            totalCount = facilities.length;

            const responseData = {
              message: `ZIP code "${normalizedZip}" not found in database. Showing nearby facilities.`,
              coordinates: { lat, lng },
              total: totalCount,
              facilities: facilities,
              page: pageNum,
              limit: limitNum,
              cached: false,
              from: "db",
            };

            if (facilities.length) {
              await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
              await CachedSearchResult.updateOne(
                { key: pageCacheKey },
                { $set: { data: responseData } },
                { upsert: true }
              );
            }

            return res.json(responseData);
          } catch (err: any) {
            console.error("❌ Google Geocode Error:", err.message);
            return res.status(400).json({
              error: `ZIP code "${normalizedZip}" not found in our database and Google lookup failed: ${err.message}`,
            });
          }
        }
      } else if (type === "state") {
        const abbr = stateToAbbr[value] || value.toUpperCase();
        if (!allowedAbbr.includes(abbr)) {
          return res.status(400).json({
            error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
          });
        }

        mongoQuery = { 
          state: abbr,
          ...baseExcludeQuery
        };
        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();

        console.log(`🏛️ Found ${facilities.length} regular facilities in state ${abbr} (total: ${totalCount})`);

      } else if (type === "city") {
        const facilityInCity = await NursingFacility.findOne({ 
          city_town: new RegExp(`^${value}$`, "i") 
        })
          .select("state")
          .lean();

        if (!facilityInCity || !allowedAbbr.includes(facilityInCity.state ?? "")) {
          return res.status(400).json({
            error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
          });
        }

        mongoQuery = { 
          city_town: new RegExp(`^${value}$`, "i"),
          ...baseExcludeQuery
        };
        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();

        console.log(`🏙️ Found ${facilities.length} regular facilities in city ${value} (total: ${totalCount})`);

      } else {
        // General search
        mongoQuery = {
          $or: [
            { city_town: new RegExp(value, "i") },
            { provider_name: new RegExp(value, "i") },
            { zip_code: new RegExp(value, "i") },
          ],
          state: { $in: allowedAbbr },
          ...baseExcludeQuery
        };

        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();

        console.log(`🔍 Found ${facilities.length} regular facilities for general search "${value}" (total: ${totalCount})`);
      }
    }

    // -----------------------------
    // 4️⃣ COMBINE SPONSORED AND REGULAR FACILITIES
    // -----------------------------
    console.log(`🏥 Found ${facilities.length} regular facilities from database`);

    // Convert sponsored facilities to the same format as regular facilities
    const sponsoredFacilitiesFormatted = matchingSponsoredFacilities.map(sponsored => ({
      ...sponsored.facility,
      isSponsored: true,
      sponsoredData: {
        priority: sponsored.priority || 1,
        startDate: sponsored.startDate,
        endDate: sponsored.endDate,
        sponsoredBy: sponsored.sponsoredBy
      }
    }));

    console.log(`🌟 Formatted ${sponsoredFacilitiesFormatted.length} sponsored facilities`);

    // Combine facilities (sponsored first, then regular)
    const allFacilities = [...sponsoredFacilitiesFormatted, ...facilities];
    console.log(`📊 Total combined facilities: ${allFacilities.length}`);

    // If we have more than limit, trim to limit
    const finalFacilities = allFacilities.slice(0, limitNum);
    console.log(`✂️ Trimmed to ${finalFacilities.length} facilities for page ${pageNum}`);

    // -----------------------------
    // 5️⃣ GOOGLE + AI ENRICHMENT FOR ALL FACILITIES
    // -----------------------------
    console.log('🔍 Fetching Google data for all facilities...');
    const googleResults = await Promise.all(
      finalFacilities.map((f) => getGoogleDataFast(f))
    );
    
    const reviewsTexts = finalFacilities.map((_: any, i: number) =>
      googleResults[i]?.reviews?.length
        ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
        : ""
    );
    
    console.log('🤖 Generating AI summaries...');
    const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

    // -----------------------------
    // 🖼️ 6️⃣ IMAGE CACHING INTEGRATION
    // -----------------------------
    console.log('🖼️ Starting image caching...');
    const facilitiesWithCachedPhotos = await Promise.all(
      finalFacilities.map(async (f: any, i: number) => {
        const gd = googleResults[i] ?? {};
        const photoRefs = gd.photoReferences || [];

        // Get cached photo URLs for this facility
        let cachedPhotoUrls: string[] = [];
        
        if (photoRefs.length > 0) {
          try {
            cachedPhotoUrls = await Promise.all(
              photoRefs.slice(0, 4).map(async (photoRef: string) => {
                const url = await getCachedPhotoUrl(
                  photoRef, 
                  600, 
                  f._id?.toString(), 
                  gd.placeId
                );
                return url;
              })
            );
            
            // Filter out null values
            cachedPhotoUrls = cachedPhotoUrls.filter(url => url !== null) as string[];
          } catch (error) {
            console.error(`❌ Error caching photos for facility ${f._id}:`, error);
          }
        } else {
          cachedPhotoUrls = gd.photos || [];
        }

        return {
          ...f,
          googleName: gd.googleName ?? null,
          rating: gd.rating ?? null,
          photos: cachedPhotoUrls,
          photoRefs: photoRefs,
          lat: gd.lat ?? f.latitude ?? null,
          lng: gd.lng ?? f.longitude ?? null,
          aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
          googlePlaceId: gd.placeId || null,
        };
      })
    );

    // -----------------------------
    // 🔥 SORT FACILITIES - SPONSORED FIRST BY PRIORITY
    // -----------------------------
    console.log('📊 Sorting facilities: sponsored first by priority...');
    const sortedFacilities = facilitiesWithCachedPhotos.sort((a, b) => {
      // First priority: sponsored facilities
      if (a.isSponsored && !b.isSponsored) return -1;
      if (!a.isSponsored && b.isSponsored) return 1;
      
      // Both sponsored: sort by priority (higher priority first)
      if (a.isSponsored && b.isSponsored) {
        const priorityA = a.sponsoredData?.priority || 1;
        const priorityB = b.sponsoredData?.priority || 1;
        return priorityB - priorityA; // Higher priority first
      }
      
      // Both not sponsored: maintain original order
      return 0;
    });

    console.log(`🎯 Final results: ${sortedFacilities.filter(f => f.isSponsored).length} sponsored, ${sortedFacilities.filter(f => !f.isSponsored).length} regular`);

    // Update total count to include sponsored facilities
    const finalTotalCount = totalCount + matchingSponsoredFacilities.length;

    const totalCachedPhotos = sortedFacilities.reduce((count, facility) => count + facility.photos.length, 0);
    const totalPhotoRefs = sortedFacilities.reduce((count, facility) => count + facility.photoRefs.length, 0);

    const responseData = {
      data: sortedFacilities,
      total: finalTotalCount,
      page: pageNum,
      limit: limitNum,
      cached: false,
      from: "db",
      sponsorshipInfo: {
        totalSponsored: sortedFacilities.filter(f => f.isSponsored).length,
        sponsoredCount: sortedFacilities.filter(f => f.isSponsored).length,
        regularCount: sortedFacilities.filter(f => !f.isSponsored).length,
        sponsoredFacilities: sortedFacilities.filter(f => f.isSponsored).map(f => ({
          id: f._id,
          name: f.provider_name,
          priority: f.sponsoredData?.priority,
          state: f.state,
          city: f.city_town,
          zip: f.zip_code
        }))
      },
      searchInfo: {
        query: q,
        type: q ? normalizeQuery(q.replace(/_/g, " ").trim()).type : 'geo',
        sponsoredMatched: matchingSponsoredFacilities.length,
        totalSponsoredAvailable: allActiveSponsored.length
      }
    };

    // Log final sponsored facilities
    if (responseData.sponsorshipInfo.totalSponsored > 0) {
      console.log('🏆 FINAL SPONSORED FACILITIES ON TOP:');
      responseData.sponsorshipInfo.sponsoredFacilities.forEach((facility: any, index: number) => {
        console.log(`   ${index + 1}. ${facility.name} (Priority: ${facility.priority}, ${facility.city}, ${facility.state})`);
      });
    } else {
      console.log('ℹ️ No sponsored facilities in final results');
    }

    // -----------------------------
    // 7️⃣ CACHE NON-EMPTY RESULTS
    // -----------------------------
    if (responseData.data.length) {
      console.log(`💾 Caching results to Redis and MongoDB`);
      await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
      await CachedSearchResult.updateOne(
        { key: pageCacheKey },
        { $set: { data: responseData } },
        { upsert: true }
      );
    }

    return res.status(200).json(responseData);
  } catch (err: any) {
    console.error("❌ API error:", err);
    res.status(500).json({ error: err.message });
  }
};

// NEW FUNCTION: Validate and update sponsored facilities in cached responses
const validateAndUpdateSponsoredFacilities = async (cachedResponse: any, q?: string, lat?: string, lng?: string) => {
  try {
    console.log('🔄 Validating sponsored facilities in cached response...');
    
    // Get current active sponsored facilities
    const currentActiveSponsored = await SponsoredFacility.find({
      isActive: true,
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() }
    })
      .populate('facility')
      .lean();

    const currentSponsoredIds = new Set(
      currentActiveSponsored.map(sp => sp.facility?._id?.toString()).filter(Boolean)
    );

    console.log(`📊 Current active sponsored facilities: ${currentActiveSponsored.length}`);
    console.log(`📊 Cached sponsored facilities: ${cachedResponse.data?.filter((f: any) => f.isSponsored).length || 0}`);

    let updated = false;
    const updatedData = [...cachedResponse.data];

    // Check each facility in cached response
    for (let i = 0; i < updatedData.length; i++) {
      const facility = updatedData[i];
      
      if (facility.isSponsored) {
        const facilityId = facility._id?.toString();
        const isCurrentlySponsored = currentSponsoredIds.has(facilityId);
        
        if (!isCurrentlySponsored) {
          console.log(`❌ Removing expired sponsored facility: ${facility.provider_name}`);
          // Remove sponsored status
          updatedData[i] = {
            ...facility,
            isSponsored: false,
            sponsoredData: undefined
          };
          updated = true;
        } else {
          // Update sponsored data with current priority and dates
          const currentSponsored = currentActiveSponsored.find(
            sp => sp.facility?._id?.toString() === facilityId
          );
          
          if (currentSponsored && (
            facility.sponsoredData?.priority !== currentSponsored.priority ||
            facility.sponsoredData?.startDate !== currentSponsored.startDate?.toISOString() ||
            facility.sponsoredData?.endDate !== currentSponsored.endDate?.toISOString()
          )) {
            console.log(`🔄 Updating sponsored data for: ${facility.provider_name}`);
            updatedData[i] = {
              ...facility,
              sponsoredData: {
                priority: currentSponsored.priority || 1,
                startDate: currentSponsored.startDate,
                endDate: currentSponsored.endDate,
                sponsoredBy: currentSponsored.sponsoredBy
              }
            };
            updated = true;
          }
        }
      }
    }

    // Add new sponsored facilities that match search criteria but aren't in cached response
    if (q || (lat && lng)) {
      const matchingSponsoredFacilities = await getMatchingSponsoredFacilities(
        currentActiveSponsored, q, lat, lng
      );

      const newSponsoredFacilities = matchingSponsoredFacilities.filter(sponsored => {
        const facilityId = sponsored.facility._id.toString();
        return !updatedData.some((f: any) => f._id?.toString() === facilityId);
      });

      if (newSponsoredFacilities.length > 0) {
        console.log(`➕ Adding ${newSponsoredFacilities.length} new sponsored facilities to cached response`);
        
        const newSponsoredFormatted = newSponsoredFacilities.map(sponsored => ({
          ...sponsored.facility,
          isSponsored: true,
          sponsoredData: {
            priority: sponsored.priority || 1,
            startDate: sponsored.startDate,
            endDate: sponsored.endDate,
            sponsoredBy: sponsored.sponsoredBy
          }
        }));

        // Add new sponsored facilities at the beginning
        updatedData.unshift(...newSponsoredFormatted);
        updated = true;
      }
    }

    if (updated) {
      // Re-sort to ensure sponsored facilities are at the top
      updatedData.sort((a: any, b: any) => {
        if (a.isSponsored && !b.isSponsored) return -1;
        if (!a.isSponsored && b.isSponsored) return 1;
        if (a.isSponsored && b.isSponsored) {
          return (b.sponsoredData?.priority || 1) - (a.sponsoredData?.priority || 1);
        }
        return 0;
      });

      // Update counts in response
      const sponsoredCount = updatedData.filter((f: any) => f.isSponsored).length;
      const regularCount = updatedData.filter((f: any) => !f.isSponsored).length;

      return {
        updated: true,
        data: {
          ...cachedResponse,
          data: updatedData,
          sponsorshipInfo: {
            ...cachedResponse.sponsorshipInfo,
            totalSponsored: sponsoredCount,
            sponsoredCount: sponsoredCount,
            regularCount: regularCount,
            sponsoredFacilities: updatedData
              .filter((f: any) => f.isSponsored)
              .map((f: any) => ({
                id: f._id,
                name: f.provider_name,
                priority: f.sponsoredData?.priority,
                state: f.state,
                city: f.city_town,
                zip: f.zip_code
              }))
          }
        }
      };
    }

    return { updated: false, data: cachedResponse };
  } catch (error) {
    console.error('❌ Error validating sponsored facilities:', error);
    return { updated: false, data: cachedResponse };
  }
};

// Helper function to get matching sponsored facilities (reused from main logic)
const getMatchingSponsoredFacilities = async (sponsoredFacilities: any[], q?: string, lat?: string, lng?: string) => {
  // This would contain the same filtering logic as in the main function
  // For brevity, I'm showing the structure - you would copy the filtering logic here
  return sponsoredFacilities; // Simplified for example
};

// Helper function to calculate distance between coordinates
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}


// Helper: Clean facility names to improve Google Text Search hits
function cleanFacilityName(name?: string | null): string {
  if (!name) return "";
  return name
    .replace(/\b(LLC|INC|LTD|LP|CO|CORP|CORPORATION|COMPANY)\b/gi, "")
    .replace(/\b(HEALTHCARE|HEALTH CARE|CARE CENTER|CARE CENTRE|CENTER|CENTRE)\b/gi, "")
    .replace(/\bAT\b/gi, " ")
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Enhanced Google enrichment that tries better query variants
async function fetchAndCacheGoogleDataEnhanced(facility: any) {
  // First, attempt the existing fast cache-aware path
  const cached = await fetchAndCacheGoogleData(facility);
  if (cached && (cached.googleName || cached.rating || (cached.photos && cached.photos.length) || (cached.reviews && cached.reviews.length))) {
    return cached;
  }

  // Build stronger query variants
  const name = cleanFacilityName(facility.provider_name || facility.legal_business_name || "");
  const city = (facility.city_town || "").trim();
  const state = (facility.state || "").trim();
  const zip = (facility.zip_code || "").trim();

  const variants = [
    `${name}, ${city}, ${state} ${zip}`.trim(),
    `${name} ${city} ${state}`.trim(),
    `${name} ${zip}`.trim(),
    `${name} nursing home ${city} ${state}`.trim(),
    `${facility.provider_name || ""}, ${city}, ${state} ${zip}`.trim(),
    `${facility.legal_business_name || ""}, ${city}, ${state} ${zip}`.trim(),
  ]
    .map(v => v.replace(/\s{2,}/g, " ").trim())
    .filter(v => v.length >= 3);

  // Try sequentially for determinism and to stop at first hit
  for (const query of variants) {
    try {
      const placeId = await findPlaceIdByText(query);
      if (!placeId) continue;
      const details = await getPlaceDetails(placeId);
      if (!details) continue;

      const photoReferences = (details.photos || []).slice(0, 4).map((p: any) => p.photo_reference);
      return {
        googleName: details.name ?? null,
        rating: details.rating ?? null,
        lat: details.lat ?? null,
        lng: details.lng ?? null,
        photos: photoReferences.map((ref: string) => googleService.getPhotoUrl(ref)).filter(Boolean),
        reviews: (details.reviews || []).slice(0, 10).map((r: any) => ({
          author_name: r.author_name,
          rating: r.rating,
          text: r.text,
          relative_time_description: r.relative_time_description,
          profile_photo_url: r.profile_photo_url,
          author_url: r.author_url,
        })),
      };
    } catch (e) {
      // Ignore and try next variant
    }
  }

  return cached || { googleName: null, rating: null, lat: null, lng: null, photos: [], reviews: [] };
}

// export const filterFacilitiesWithReviews = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const {
//       city,
//       state,
//       zip,
//       bedsMin,
//       bedsMax,
//       ownership,
//       distanceKm,
//       userLat,
//       userLng,
//       locationName,
//       fromLocation,
//       toLocation,
//       ratingMin,
//       page = "1",
//       limit = "8",
//     } = req.query as any;

//     const pageNum = parseInt(page as string);
//     const limitNum = parseInt(limit as string);

//     // 🗝️ Generate cache key from all parameters
//     const cacheKeyParams = {
//       city,
//       state,
//       zip,
//       bedsMin,
//       bedsMax,
//       ownership,
//       distanceKm,
//       userLat,
//       userLng,
//       locationName,
//       fromLocation,
//       toLocation,
//       ratingMin,
//       page: pageNum,
//       limit: limitNum,
//     };
    
//     const pageCacheKey = `filter_facilities:${JSON.stringify(cacheKeyParams)}`;
//     const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

//     // -----------------------------
//     // 1️⃣ Redis Cache Check
//     // -----------------------------
//     const cachedRedis = await getCache(pageCacheKey);
//     if (cachedRedis) {
//       const parsed = JSON.parse(cachedRedis);
//       if (!parsed.data?.facilities?.length) {
//         await deleteCache(pageCacheKey);
//       } else {
//         console.log("⚡ Serving filtered facilities from Redis cache");
//         return res.status(200).json({ ...parsed, cached: true, from: "redis" });
//       }
//     }

//     // -----------------------------
//     // 2️⃣ Mongo Cache Collection
//     // -----------------------------
//     const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
//     if (mongoCache) {
//       if (!mongoCache.data?.facilities?.length) {
//         await CachedSearchResult.deleteOne({ key: pageCacheKey });
//       } else {
//         console.log("⚡ Serving filtered facilities from MongoDB cache");
//         await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
//         return res
//           .status(200)
//           .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
//       }
//     }

//     console.log("🔄 Cache miss - fetching fresh filtered facilities data");

//     const pipeline: any[] = [];
//     const countPipeline: any[] = [];
//     const matchQuery: any = {};
//     let finalLat: number | null = null;
//     let finalLng: number | null = null;
//     let finalDistanceKm: number | null = null;
//     let fromToDistanceKm: number | null = null;
//     let isGeoSearch = false;

//     // 🗺️ 1️⃣ FROM → TO SEARCH
//     if (fromLocation && toLocation) {
//       isGeoSearch = true;
//       try {
//         const fromCoords = await getCoordinatesByPlaceName(
//           fromLocation.replace(/_/g, " ")
//         );
//         const toCoords = await getCoordinatesByPlaceName(
//           toLocation.replace(/_/g, " ")
//         );

//         const R = 6371;
//         const dLat = ((toCoords.lat - fromCoords.lat) * Math.PI) / 180;
//         const dLon = ((toCoords.lng - fromCoords.lng) * Math.PI) / 180;
//         const a =
//           Math.sin(dLat / 2) ** 2 +
//           Math.cos((fromCoords.lat * Math.PI) / 180) *
//             Math.cos((toCoords.lat * Math.PI) / 180) *
//             Math.sin(dLon / 2) ** 2;
//         const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//         fromToDistanceKm = R * c;

//         finalLat = (fromCoords.lat + toCoords.lat) / 2;
//         finalLng = (fromCoords.lng + toCoords.lng) / 2;
//         finalDistanceKm = fromToDistanceKm / 2 + 50;
//       } catch (err: any) {
//         console.error("Google FROM-TO error:", err);
//         return res.status(400).json({
//           message: "Failed to fetch coordinates for FROM/TO locations.",
//         });
//       }
//     }

//     // 📍 2️⃣ USER LOCATION SEARCH
//     else if (userLat && userLng) {
//       isGeoSearch = true;
//       finalLat = parseFloat(userLat);
//       finalLng = parseFloat(userLng);
//       finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
//     }

//     // 🧭 3️⃣ LOCATION NAME SEARCH
//     else if (locationName) {
//       isGeoSearch = true;
//       try {
//         const coords = await getCoordinatesByPlaceName(
//           locationName.replace(/_/g, " ")
//         );
//         finalLat = coords.lat;
//         finalLng = coords.lng;
//         finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
//       } catch (err: any) {
//         console.error("Google locationName error:", err);
//         return res.status(400).json({
//           message: `Failed to fetch coordinates for "${locationName}". Please check the input.`,
//         });
//       }
//     }

//     // 🏙️ 4️⃣ CITY / STATE / ZIP FILTERS
//     if (city) matchQuery.city_town = new RegExp(city, "i");
//     if (state) matchQuery.state = state.toUpperCase();
//     if (zip) matchQuery.zip_code = zip;

//     // 🏠 5️⃣ OWNERSHIP TYPE
//     if (ownership) {
//       const ownershipArray = ownership.split(",").map((o: string) => o.trim());
//       matchQuery.ownership_type = { $in: ownershipArray };
//     }

//     // 🛏️ 6️⃣ BEDS RANGE FILTER
//     if (bedsMin || bedsMax) {
//       matchQuery.number_of_certified_beds = {};
//       if (bedsMin) matchQuery.number_of_certified_beds.$gte = parseInt(bedsMin);
//       if (bedsMax) matchQuery.number_of_certified_beds.$lte = parseInt(bedsMax);
//     }

//     // 🌎 7️⃣ GEO FILTER
//     if (isGeoSearch && finalLat && finalLng) {
//       pipeline.push({
//         $geoNear: {
//           near: { type: "Point", coordinates: [finalLng, finalLat] },
//           distanceField: "distance_m",
//           key: "geoLocation",
//           maxDistance: (finalDistanceKm || 20) * 1000,
//           spherical: true,
//           query: matchQuery,
//         },
//       });
      
//       countPipeline.push({
//         $geoNear: {
//           near: { type: "Point", coordinates: [finalLng, finalLat] },
//           distanceField: "distance_m",
//           key: "geoLocation",
//           maxDistance: (finalDistanceKm || 20) * 1000,
//           spherical: true,
//           query: matchQuery,
//         },
//       });
//     } else {
//       pipeline.push({ $match: matchQuery });
//       countPipeline.push({ $match: matchQuery });
//     }

//     // ⭐ 8️⃣ RATING FILTER
//     const ratingMinNum = ratingMin ? parseInt(ratingMin) : null;
//     if (ratingMinNum && ratingMinNum >= 1 && ratingMinNum <= 5) {
//       pipeline.push({
//         $addFields: {
//           numeric_overall_rating: {
//             $cond: {
//               if: {
//                 $and: [
//                   { $ifNull: ["$overall_rating", false] },
//                   { $ne: ["$overall_rating", ""] },
//                 ],
//               },
//               then: { $toDouble: "$overall_rating" },
//               else: 0,
//             },
//           },
//         },
//       });

//       pipeline.push({
//         $match: { numeric_overall_rating: { $gte: ratingMinNum } },
//       });
      
//       countPipeline.push({
//         $addFields: {
//           numeric_overall_rating: {
//             $cond: {
//               if: {
//                 $and: [
//                   { $ifNull: ["$overall_rating", false] },
//                   { $ne: ["$overall_rating", ""] },
//                 ],
//               },
//               then: { $toDouble: "$overall_rating" },
//               else: 0,
//             },
//           },
//         },
//       });
      
//       countPipeline.push({
//         $match: { numeric_overall_rating: { $gte: ratingMinNum } },
//       });
//     }

//     // 🔢 9️⃣ PAGINATION
//     const skip = (pageNum - 1) * limitNum;

//     // Get total count
//     countPipeline.push({ $count: "totalCount" });
//     const countResult = await NursingFacility.aggregate(countPipeline);
//     const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
//     const totalPages = Math.ceil(totalCount / limitNum);

//     // Apply pagination to main pipeline
//     pipeline.push({ $skip: skip });
//     pipeline.push({ $limit: limitNum });

//     console.log(`📊 Filtered Pagination: Page ${pageNum}, Total: ${totalCount}`);

//     // 🚀 EXECUTE QUERY
//     const facilities = await NursingFacility.aggregate(pipeline);

//     // -----------------------------
//     // 🔄 EMPTY RESULT HANDLING
//     // -----------------------------
//     if (!facilities.length) {
//       await deleteCache(pageCacheKey);
//       await CachedSearchResult.deleteOne({ key: pageCacheKey });

//       return res.status(200).json({
//         data: {
//           facilities: [],
//           pagination: {
//             currentPage: pageNum,
//             totalPages: 0,
//             totalCount: 0,
//             hasNextPage: false,
//             hasPrevPage: false,
//             limit: limitNum
//           }
//         },
//         cached: false,
//         from: "db",
//       });
//     }

//     // 🧠 GOOGLE PLACE DATA + AI SUMMARIZATION
//     console.log("🌐 Fetching Google Places data for facilities...");
//     const googleResults = await Promise.all(
//       facilities.map((f: any) => getGoogleDataFast(f))
//     );

//     console.log("🤖 Generating AI summaries for reviews...");
//     const reviewsTexts = facilities.map((_: any, i: number) =>
//       googleResults[i]?.reviews?.length
//         ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//         : ""
//     );
    
//     const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//     const finalResults = facilities.map((f: any, i: number) => {
//       const g = googleResults[i] || {};
//       return {
//         ...f,
//         distance_km: f.distance_m ? f.distance_m / 1000 : null,
//         googleName: g.googleName || null,
//         rating: g.rating || null,
//         photo: g.photos?.[0] || null,
//         lat: g.lat || f.latitude || null,
//         lng: g.lng || f.longitude || null,
//         aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//       };
//     });

//     // 📦 BUILD RESPONSE - FIXED TYPE STRUCTURE
//     const responseData: any = {
//       data: {
//         facilities: finalResults,
//         pagination: {
//           currentPage: pageNum,
//           totalPages: totalPages,
//           totalCount: totalCount,
//           hasNextPage: pageNum < totalPages,
//           hasPrevPage: pageNum > 1,
//           limit: limitNum
//         }
//       }
//     };
    
//     // ✅ FIXED: Add location metadata at the root level of data
//     if (fromLocation && toLocation) {
//       responseData.data.fromLocation = fromLocation;
//       responseData.data.toLocation = toLocation;
//       responseData.data.fromToDistanceKm = fromToDistanceKm;
//     } else if (isGeoSearch && finalLat && finalLng) {
//       responseData.data.centerCoords = { lat: finalLat, lng: finalLng };
//     }

//     // 💾 CACHE THE RESULTS
//     try {
//       // Cache in Redis
//       await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
      
//       // Cache in MongoDB
//       await CachedSearchResult.findOneAndUpdate(
//         { key: pageCacheKey },
//         { 
//           key: pageCacheKey,
//           data: responseData,
//           createdAt: new Date(),
//           expiresAt: new Date(Date.now() + ONE_YEAR_MS)
//         },
//         { upsert: true, new: true }
//       );
      
//       console.log(`💾 Cached filtered facilities for key: ${pageCacheKey}`);
//     } catch (cacheError) {
//       console.error("❌ Failed to cache filtered facilities:", cacheError);
//       // Don't fail the request if caching fails
//     }

//     // ✅ RETURN RESPONSE
//     return res.status(200).json({
//       ...responseData,
//       cached: false,
//       from: "db+google+ai"
//     });
//   } catch (err: any) {
//     console.error("❌ Error in filterFacilitiesWithReviews:", err);
//     res.status(500).json({ message: "Internal server error." });
//   }
// };

export const filterFacilitiesWithReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const {
      city,
      state,
      zip,
      bedsMin,
      bedsMax,
      ownership,
      distanceKm,
      userLat,
      userLng,
      locationName,
      fromLocation,
      toLocation,
      ratingMin,
      page = "1",
      limit = "8",
    } = req.query as any;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    // 🗝️ Generate cache key from all parameters
    const cacheKeyParams = {
      city,
      state,
      zip,
      bedsMin,
      bedsMax,
      ownership,
      distanceKm,
      userLat,
      userLng,
      locationName,
      fromLocation,
      toLocation,
      ratingMin,
      page: pageNum,
      limit: limitNum,
    };
    
    const pageCacheKey = `filter_facilities:${JSON.stringify(cacheKeyParams)}`;
    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

    // -----------------------------
    // 1️⃣ Redis Cache Check
    // -----------------------------
    const cachedRedis = await getCache(pageCacheKey);
    if (cachedRedis) {
      const parsed = JSON.parse(cachedRedis);
      if (!parsed.data?.facilities?.length) {
        await deleteCache(pageCacheKey);
      } else {
        console.log("⚡ Serving filtered facilities from Redis cache");
        return res.status(200).json({ ...parsed, cached: true, from: "redis" });
      }
    }

    // -----------------------------
    // 2️⃣ Mongo Cache Collection
    // -----------------------------
    const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
    if (mongoCache) {
      if (!mongoCache.data?.facilities?.length) {
        await CachedSearchResult.deleteOne({ key: pageCacheKey });
      } else {
        console.log("⚡ Serving filtered facilities from MongoDB cache");
        await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
        return res
          .status(200)
          .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
      }
    }

    console.log("🔄 Cache miss - fetching fresh filtered facilities data");

    const pipeline: any[] = [];
    const matchQuery: any = {};
    let finalLat: number | null = null;
    let finalLng: number | null = null;
    let finalDistanceKm: number | null = null;
    let fromToDistanceKm: number | null = null;
    let isGeoSearch = false;

    // 🗺️ 1️⃣ FROM → TO SEARCH
    if (fromLocation && toLocation) {
      isGeoSearch = true;
      try {
        const fromCoords = await getCoordinatesByPlaceName(
          fromLocation.replace(/_/g, " ")
        );
        const toCoords = await getCoordinatesByPlaceName(
          toLocation.replace(/_/g, " ")
        );

        const R = 6371;
        const dLat = ((toCoords.lat - fromCoords.lat) * Math.PI) / 180;
        const dLon = ((toCoords.lng - fromCoords.lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((fromCoords.lat * Math.PI) / 180) *
            Math.cos((toCoords.lat * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        fromToDistanceKm = R * c;

        finalLat = (fromCoords.lat + toCoords.lat) / 2;
        finalLng = (fromCoords.lng + toCoords.lng) / 2;
        finalDistanceKm = fromToDistanceKm / 2 + 50;
      } catch (err: any) {
        console.error("Google FROM-TO error:", err);
        return res.status(400).json({
          message: "Failed to fetch coordinates for FROM/TO locations.",
        });
      }
    }

    // 📍 2️⃣ USER LOCATION SEARCH
    else if (userLat && userLng) {
      isGeoSearch = true;
      finalLat = parseFloat(userLat);
      finalLng = parseFloat(userLng);
      finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
    }

    // 🧭 3️⃣ LOCATION NAME SEARCH
    else if (locationName) {
      isGeoSearch = true;
      try {
        const coords = await getCoordinatesByPlaceName(
          locationName.replace(/_/g, " ")
        );
        finalLat = coords.lat;
        finalLng = coords.lng;
        finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
      } catch (err: any) {
        console.error("Google locationName error:", err);
        return res.status(400).json({
          message: `Failed to fetch coordinates for "${locationName}". Please check the input.`,
        });
      }
    }

    // 🏙️ 4️⃣ CITY / STATE / ZIP FILTERS
    if (city) matchQuery.city_town = new RegExp(city, "i");
    if (state) matchQuery.state = state.toUpperCase();
    if (zip) matchQuery.zip_code = zip;

    // 🏠 5️⃣ OWNERSHIP TYPE
    if (ownership) {
      const ownershipArray = ownership.split(",").map((o: string) => o.trim());
      matchQuery.ownership_type = { $in: ownershipArray };
    }

    // 🛏️ 6️⃣ BEDS RANGE FILTER
    if (bedsMin || bedsMax) {
      matchQuery.number_of_certified_beds = {};
      if (bedsMin) matchQuery.number_of_certified_beds.$gte = parseInt(bedsMin);
      if (bedsMax) matchQuery.number_of_certified_beds.$lte = parseInt(bedsMax);
    }

    // 🌎 7️⃣ GEO FILTER - MAIN PIPELINE
    if (isGeoSearch && finalLat && finalLng) {
      pipeline.push({
        $geoNear: {
          near: { type: "Point", coordinates: [finalLng, finalLat] },
          distanceField: "distance_m",
          key: "geoLocation",
          maxDistance: (finalDistanceKm || 20) * 1000,
          spherical: true,
          query: matchQuery,
        },
      });
    } else {
      pipeline.push({ $match: matchQuery });
    }

    // ⭐ 8️⃣ RATING FILTER
    const ratingMinNum = ratingMin ? parseInt(ratingMin) : null;
    if (ratingMinNum && ratingMinNum >= 1 && ratingMinNum <= 5) {
      pipeline.push({
        $addFields: {
          numeric_overall_rating: {
            $cond: {
              if: {
                $and: [
                  { $ifNull: ["$overall_rating", false] },
                  { $ne: ["$overall_rating", ""] },
                ],
              },
              then: { $toDouble: "$overall_rating" },
              else: 0,
            },
          },
        },
      });

      pipeline.push({
        $match: { numeric_overall_rating: { $gte: ratingMinNum } },
      });
    }

    // 🔢 9️⃣ COUNT TOTAL DOCUMENTS WITH CURRENT FILTERS
    // Create a separate count pipeline that applies ALL the same filters
    const countPipeline = [...pipeline];
    
    // Remove pagination stages if they exist and add count stage
    countPipeline.push({ $count: "totalCount" });

    // 🔢 PAGINATION - Add to main pipeline after counting
    const skip = (pageNum - 1) * limitNum;
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    console.log("📊 Executing count query with filters...");
    const countResult = await NursingFacility.aggregate(countPipeline);
    const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
    const totalPages = Math.ceil(totalCount / limitNum);

    console.log(`📊 Filtered Pagination: Page ${pageNum}, Total: ${totalCount}, Distance: ${finalDistanceKm}km`);

    // 🚀 EXECUTE MAIN QUERY
    const facilities = await NursingFacility.aggregate(pipeline);

    // -----------------------------
    // 🔄 EMPTY RESULT HANDLING
    // -----------------------------
    if (!facilities.length) {
      await deleteCache(pageCacheKey);
      await CachedSearchResult.deleteOne({ key: pageCacheKey });

      return res.status(200).json({
        data: {
          facilities: [],
          pagination: {
            currentPage: pageNum,
            totalPages: 0,
            totalCount: 0,
            hasNextPage: false,
            hasPrevPage: false,
            limit: limitNum
          }
        },
        cached: false,
        from: "db",
      });
    }

    // 🧠 GOOGLE PLACE DATA + AI SUMMARIZATION
    console.log("🌐 Fetching Google Places data for facilities...");
    const googleResults = await Promise.all(
      facilities.map((f: any) => getGoogleDataFast(f))
    );

    console.log("🤖 Generating AI summaries for reviews...");
    const reviewsTexts = facilities.map((_: any, i: number) =>
      googleResults[i]?.reviews?.length
        ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
        : ""
    );
    
    const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

    const finalResults = facilities.map((f: any, i: number) => {
      const g = googleResults[i] || {};
      return {
        ...f,
        distance_km: f.distance_m ? f.distance_m / 1000 : null,
        googleName: g.googleName || null,
        rating: g.rating || null,
        photo: g.photos?.[0] || null,
        lat: g.lat || f.latitude || null,
        lng: g.lng || f.longitude || null,
        aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
      };
    });

    // 📦 BUILD RESPONSE - FIXED TYPE STRUCTURE
    const responseData: any = {
      data: {
        facilities: finalResults,
        pagination: {
          currentPage: pageNum,
          totalPages: totalPages,
          totalCount: totalCount,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1,
          limit: limitNum
        }
      }
    };
    
    // ✅ FIXED: Add location metadata at the root level of data
    if (fromLocation && toLocation) {
      responseData.data.fromLocation = fromLocation;
      responseData.data.toLocation = toLocation;
      responseData.data.fromToDistanceKm = fromToDistanceKm;
    } else if (isGeoSearch && finalLat && finalLng) {
      responseData.data.centerCoords = { lat: finalLat, lng: finalLng };
      responseData.data.searchRadiusKm = finalDistanceKm;
    }

    // 💾 CACHE THE RESULTS
    try {
      // Cache in Redis
      await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
      
      // Cache in MongoDB
      await CachedSearchResult.findOneAndUpdate(
        { key: pageCacheKey },
        { 
          key: pageCacheKey,
          data: responseData,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + ONE_YEAR_MS)
        },
        { upsert: true, new: true }
      );
      
      console.log(`💾 Cached filtered facilities for key: ${pageCacheKey}`);
    } catch (cacheError) {
      console.error("❌ Failed to cache filtered facilities:", cacheError);
      // Don't fail the request if caching fails
    }

    // ✅ RETURN RESPONSE
    return res.status(200).json({
      ...responseData,
      cached: false,
      from: "db+google+ai"
    });
  } catch (err: any) {
    console.error("❌ Error in filterFacilitiesWithReviews:", err);
    res.status(500).json({ message: "Internal server error." });
  }
};


export const searchFacilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { city, state, zip } = req.query as { city?: string; state?: string; zip?: string };

    const query: any = {};
    if (city) query.city = new RegExp(city, "i");
    if (state) query.state = state.toUpperCase();
    if (zip) query.zip = zip;

    const facilities = await Facility.find(query).limit(50);
    res.json(facilities);
  } catch (err) {
    next(err);
  }
};

// export const getFacilityById = async (req: Request, res: Response, next: NextFunction) => {
//   try {
//     const facility = await Facility.findById(req.params.id);
//     if (!facility) return res.status(404).json({ message: "Not found" });

//     // Optional: enrich with Google data
//     // const queryText = `${facility.name}, ${facility.address}, ${facility.city}, ${facility.state}`;
//     const queryText = `${facility.name}`;
//     const placeId = await googleService.findPlaceIdByText(queryText);

//     let googleData: PlaceDetails | null = null;
//     if (placeId) {
//       googleData = await googleService.getPlaceDetails(placeId);
//     }

//     res.json({
//       success: true,
//       data: {
//         ...facility.toObject(),
//         google: googleData, // photos, map URL, rating, etc.
//       },
//     });
//   } catch (err) {
//     next(err);
//   }
// };

export const getFacilityById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const facility = await Facility.findById(req.params.id);
    if (!facility) return res.status(404).json({ message: "Not found" });

    const queryText = `${facility.provider_name}`;
    const placeId = await googleService.findPlaceIdByText(queryText);

    // Optional Google enrichment
    let googleData: PlaceDetails | null = null;
    if (placeId) {
      googleData = await googleService.getPlaceDetails(placeId);
    }

    // 👇 Return only name (local DB name or Google name)
    return res.json({
      success: true,
      name: facility.provider_name, // from your DB
      google_name: googleData?.name ?? null // from Google
    });
  } catch (err) {
    next(err);
  }
};


export const syncFacilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await cmsService.syncFacilities();
    res.json(result);
  } catch (err) {
    next(err);
  }
};


export const fetchFromCMS = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await axios.post(
      CMS_API_URL,
      {
        conditions: [
          {
            resource: "t",
            property: "record_number",
            value: 1,
            operator: ">",
          },
        ],
        limit: 10,
      },
      {
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
      }
    );

    res.json(data.results || []);
  } catch (err: any) {
    console.error("CMS API error:", err.message);
    res.status(500).json({ error: "Failed to fetch CMS data" });
  }
};

// 🚀 NEW: Optimized batch processing endpoint for Google data
export const batchProcessFacilitiesGoogleData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { facilityIds, limit = 50 } = req.body as { 
      facilityIds?: string[], 
      limit?: number 
    };

    if (!facilityIds || facilityIds.length === 0) {
      return res.status(400).json({ 
        message: "facilityIds array is required" 
      });
    }

    // Limit batch size to prevent overwhelming the API
    const maxBatchSize = Math.min(limit, 100);
    const facilitiesToProcess = facilityIds.slice(0, maxBatchSize);

    console.log(`🔄 Starting batch processing for ${facilitiesToProcess.length} facilities`);

    // Fetch facility data from database
    const facilities = await Facility.find({
      _id: { $in: facilitiesToProcess }
    }).select('_id provider_name zip_code city_town').lean();

    if (facilities.length === 0) {
      return res.status(404).json({ message: "No facilities found" });
    }

    // Convert to batch processing format
    const facilityData: FacilityGoogleData[] = facilities
      .filter(facility => facility.provider_name) // Filter out facilities without provider_name
      .map(facility => ({
        facilityId: facility._id.toString(),
        providerName: facility.provider_name!, // Non-null assertion since we filtered above
        zipCode: facility.zip_code || undefined,
        cityTown: facility.city_town || undefined,
      }));

    // Process facilities in batches
    const results = await batchProcessFacilities(facilityData);

    // Update database with results
    const updatePromises = results.map(async (result) => {
      if (result.placeDetails) {
        const cacheData = {
          placeId: result.placeId,
          googleName: result.placeDetails.name,
          rating: result.placeDetails.rating,
          lat: result.placeDetails.lat,
          lng: result.placeDetails.lng,
          photoReferences: result.placeDetails.photos.slice(0, 4).map(p => p.photo_reference),
          reviews: result.placeDetails.reviews.slice(0, 10).map(r => ({
            author_name: r.author_name,
            rating: r.rating,
            text: r.text,
            relative_time_description: r.relative_time_description,
            profile_photo_url: (r as any).profile_photo_url,
            author_url: (r as any).author_url,
          })),
          lastUpdated: new Date(),
        };

        return Facility.updateOne(
          { _id: result.facilityId },
          { $set: { googleCache: cacheData } }
        );
      }
      return null;
    });

    await Promise.allSettled(updatePromises.filter(Boolean));

    const successCount = results.filter(r => r.placeId).length;
    const apiStats = getApiUsageStats();

    res.json({
      message: `Batch processing complete: ${successCount}/${facilities.length} facilities processed successfully`,
      results: results.map(r => ({
        facilityId: r.facilityId,
        success: !!r.placeId,
        error: r.error || null,
      })),
      apiUsage: {
        totalRequests: apiStats.totalRequests,
        cacheHits: apiStats.cacheHits,
        cacheMisses: apiStats.cacheMisses,
        cacheHitRate: apiStats.totalRequests > 0 ? 
          (apiStats.cacheHits / apiStats.totalRequests * 100).toFixed(2) + '%' : '0%',
      },
    });

  } catch (err) {
    console.error("❌ Error in batchProcessFacilitiesGoogleData:", err);
    next(err);
  }
};

// 📊 NEW: API usage monitoring endpoint
export const getGoogleApiUsageStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const stats = getApiUsageStats();
    
    // Calculate estimated costs (rough estimates based on Google's pricing)
    const estimatedCosts = {
      textSearchRequests: (stats.requestsByType['place_id'] || 0) * 0.017, // $0.017 per request
      placeDetailsRequests: (stats.requestsByType['place_details'] || 0) * 0.017, // $0.017 per request
      geocodingRequests: (stats.requestsByType['coordinates'] || 0) * 0.005, // $0.005 per request
    };

    const totalEstimatedCost = Object.values(estimatedCosts).reduce((sum, cost) => sum + cost, 0);

    res.json({
      ...stats,
      estimatedCosts,
      totalEstimatedCost: totalEstimatedCost.toFixed(4),
      recommendations: [
        stats.cacheHits < stats.cacheMisses ? 
          "Consider increasing cache TTL to reduce API calls" : 
          "Good cache hit rate!",
        stats.totalRequests > 1000 ? 
          "High API usage detected. Consider implementing more aggressive caching." : 
          "API usage is within reasonable limits.",
      ],
    });
  } catch (err) {
    console.error("❌ Error in getGoogleApiUsageStats:", err);
    next(err);
  }
};

// 🔄 NEW: Reset API usage stats endpoint
export const resetGoogleApiUsageStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    resetApiUsageStats();
    res.json({ message: "API usage stats reset successfully" });
  } catch (err) {
    console.error("❌ Error in resetGoogleApiUsageStats:", err);
    next(err);
  }
};


// // Add this to your controller
// export const refreshFacilityGoogleData = async (req: Request, res: Response) => {
//   try {
//     const { facilityId } = req.params;
//     console.log(`🔄 Refresh request for facility ID: ${facilityId}`);
//     const facility = await NursingFacility.findById(facilityId);
//     if (!facility) {
//       return res.status(404).json({ error: 'Facility not found' });
//     }

//     // Force refresh by calling the background refresh function directly
//     const REDIS_KEY = `facility:${facilityId}:google`;
    
//     // Clear existing cache
//     await deleteCache(REDIS_KEY);
    
//     // Trigger refresh
//     await refreshGoogleDataInBackground(facility, REDIS_KEY);
    
//     res.json({ 
//       message: 'Google data refresh triggered',
//       facilityId,
//       status: 'processing'
//     });
//   } catch (error) {
//     console.error('Refresh error:', error);
//     res.status(500).json({ error: 'Refresh failed' });
//   }
// };

// Additional utility endpoints
export const refreshFacilityGoogleData = async (req: Request, res: Response) => {
  try {
    const { facilityId } = req.params;
    
    const facility = await NursingFacility.findById(facilityId);
    if (!facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    const REDIS_KEY = `facility:${facilityId}:google`;
    
    // Clear existing cache
    await deleteCache(REDIS_KEY);
    
    // Trigger refresh
    await refreshGoogleDataInBackground(facility, REDIS_KEY);
    
    res.json({ 
      message: 'Google data refresh triggered',
      facilityId,
      status: 'processing'
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Refresh failed' });
  }
};


// Batch refresh multiple facilities
export const batchRefreshGoogleData = async (req: Request, res: Response) => {
  try {
    const { limit = 10 } = req.query;
    
    const facilities = await NursingFacility.find()
      .limit(Number(limit))
      .lean();

    const results = await Promise.all(
      facilities.map(async (facility) => {
        const REDIS_KEY = `facility:${facility._id}:google`;
        await deleteCache(REDIS_KEY);
        await refreshGoogleDataInBackground(facility, REDIS_KEY);
        return { facilityId: facility._id, status: 'refreshed' };
      })
    );

    res.json({
      message: `Refreshed Google data for ${results.length} facilities`,
      results
    });
  } catch (error) {
    console.error('Batch refresh error:', error);
    res.status(500).json({ error: 'Batch refresh failed' });
  }
};

export const testGoogleApi = async (req: Request, res: Response) => {
  try {
    const testAddress = "2000 EAST MAIN STREET,PEEKSKILL,NY,10566";
    
    const coords = await getCoordinatesByPlaceName(testAddress);
    const placeId = await findPlaceIdByText(testAddress);
    
    let details = null;
    if (placeId) {
      details = await getPlaceDetails(placeId);
    }
    
    res.json({
      geocoding: coords,
      placeId,
      details: details ? {
        name: details.name,
        rating: details.rating,
        photos: details.photos?.length || 0,
        photoReferences: details.photos?.slice(0, 2).map((p: any) => p.photo_reference) || []
      } : null,
      status: 'Google API test completed'
    });
  } catch (error: any) {
    console.error('Google API test failed:', error);
    res.status(500).json({ error: 'Google API test failed', details: error.message });
  }
};



export const testGooglePlacesApi = async (req: Request, res: Response) => {
  try {
    const { testQuery = "2000 EAST MAIN STREET,PEEKSKILL,NY,10566" } = req.query;
    
    console.log('🧪 Testing Google Places API...');
    
    // Test 1: Check API key
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ 
        error: 'No Google API key found',
        status: 'FAILED'
      });
    }

    console.log('✅ API Key found:', apiKey.substring(0, 10) + '...');

    // Test 2: Test Places API findPlaceFromText directly
    const placesUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(testQuery as string)}&inputtype=textquery&fields=place_id,name,rating,photos&key=${apiKey}`;
    
    console.log('🔍 Testing Places API...');
    const placesResponse = await fetch(placesUrl);
    const placesData = await placesResponse.json();
    
    console.log('📊 Places API Response:', {
      status: placesData.status,
      candidates: placesData.candidates?.length || 0
    });

    // Test 3: Test your existing functions
    console.log('🔍 Testing findPlaceIdByText...');
    const placeId = await findPlaceIdByText(testQuery as string);
    
    let placeDetails = null;
    if (placeId) {
      console.log('📋 Testing getPlaceDetails...');
      placeDetails = await getPlaceDetails(placeId);
    }

    // Test 4: Test photo URL generation
    let testPhotoUrl = null;
    if (placeDetails?.photos?.[0]) {
      testPhotoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${placeDetails.photos[0].photo_reference}&key=${apiKey}`;
    }

    const result = {
      apiKey: {
        exists: !!apiKey,
        preview: apiKey.substring(0, 10) + '...'
      },
      directPlacesApi: {
        url: placesUrl.substring(0, 100) + '...',
        status: placesData.status,
        candidates: placesData.candidates?.length || 0,
        candidateDetails: placesData.candidates?.[0] ? {
          place_id: placesData.candidates[0].place_id,
          name: placesData.candidates[0].name,
          rating: placesData.candidates[0].rating,
          photos_count: placesData.candidates[0].photos?.length || 0
        } : null
      },
      yourFunctions: {
        findPlaceIdByText: {
          success: !!placeId,
          placeId: placeId
        },
        getPlaceDetails: {
          success: !!placeDetails,
          details: placeDetails ? {
            name: placeDetails.name,
            rating: placeDetails.rating,
            photos_count: placeDetails.photos?.length || 0,
            reviews_count: placeDetails.reviews?.length || 0
          } : null
        }
      },
      photoTest: {
        canGenerateUrl: !!testPhotoUrl,
        sampleUrl: testPhotoUrl ? testPhotoUrl.substring(0, 100) + '...' : null
      },
      status: placesData.status === 'OK' ? 'WORKING' : 'FAILED'
    };

    console.log('🎯 Test Results:', JSON.stringify(result, null, 2));
    
    res.json(result);

  } catch (error: any) {
    console.error('❌ Google Places API Test Failed:', error);
    res.status(500).json({
      error: error.message,
      status: 'FAILED'
    });
  }
};