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
      };
    }

    // 3️⃣ If nothing in Redis or Mongo — fetch fresh from Google
    return await refreshGoogleDataInBackground(facility, REDIS_KEY, true);
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
  };
};


/**
 * 🔁 Helper — refreshes Google data and updates Redis + Mongo
 * @param facility Facility object
 * @param REDIS_KEY Redis cache key
 * @param immediateReturn If true, return the fetched data; else run in background
 */
async function refreshGoogleDataInBackground(
  facility: any,
  REDIS_KEY: string,
  immediateReturn: boolean = false
) {
  try {
    // 🚀 Faster for single facility: avoid batch processor
    const placeIdCandidates = await Promise.allSettled([
      findPlaceIdByText(facility.provider_name),
      findPlaceIdByText(`${facility.provider_name} ${facility.zip_code || ""}`.trim()),
      findPlaceIdByText(`${facility.provider_name} ${facility.city_town || ""}`.trim()),
    ]);

    const fulfilledCandidate = placeIdCandidates.find(
      (r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled" && !!(r as PromiseFulfilledResult<string | null>).value
    );
    const placeId = (fulfilledCandidate?.value ?? undefined) as string | undefined;

    if (!placeId) {
      return null;
    }

    const details = await getPlaceDetails(placeId);
    if (!details) {
      return null;
    }

    const photoReferences = details.photos
      ? details.photos.slice(0, 4).map((p: any) => p.photo_reference)
      : [];

    const reviews = (details.reviews || []).slice(0, 10).map((r: any) => ({
      author_name: r.author_name,
      rating: r.rating,
      text: r.text,
      relative_time_description: r.relative_time_description,
      profile_photo_url: r.profile_photo_url,
      author_url: r.author_url,
    }));

    const now = new Date();
    const newCache = {
      placeId,
      googleName: details.name,
      rating: details.rating,
      lat: details.lat,
      lng: details.lng,
      photoReferences,
      reviews,
      lastUpdated: now,
      reviewsLastUpdated: now,
    };

    await Promise.allSettled([
      setCache(REDIS_KEY, JSON.stringify(newCache)),
      Facility.updateOne(
        { _id: facility._id },
        { $set: { googleCache: newCache } },
        { upsert: true }
      ),
    ]);

    if (immediateReturn) {
      return {
        googleName: newCache.googleName,
        rating: newCache.rating,
        lat: newCache.lat,
        lng: newCache.lng,
        photos: photoReferences.map((ref) => googleService.getPhotoUrl(ref)),
        reviews,
      };
    }
  } catch (err) {
    console.error(`Background refresh failed for ${facility.provider_name}:`, err);
  }

  return null;
}


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
      if (isCoreStale || areReviewsStale) {
        // fire and forget
        refreshGoogleDataInBackground(facility, REDIS_KEY);
      }

      const photoUrls = (parsed.photoReferences || [])
        .slice(0, 4)
        .map((ref: string) => googleService.getPhotoUrl(ref));

      return {
        googleName: parsed.googleName ?? null,
        rating: parsed.rating ?? null,
        lat: parsed.lat ?? null,
        lng: parsed.lng ?? null,
        photos: photoUrls,
        reviews: parsed.reviews || [],
        hadCache: true,
        placeId: parsed.placeId || null, // ✅ Added placeId
      };
    }

    const mongoCache = facility.googleCache;
    if (mongoCache && mongoCache.lastUpdated) {
      // store to Redis for next time (non-blocking)
      setCache(REDIS_KEY, JSON.stringify(mongoCache)).catch(() => {});

      const photoUrls = (mongoCache.photoReferences || []).slice(0, 4).map((ref: string) => googleService.getPhotoUrl(ref));
      // background refresh if stale
      const lastUpdated = new Date(mongoCache.lastUpdated);
      const isCoreStale = now.getTime() - lastUpdated.getTime() > ONE_YEAR_MS;
      const reviewsLastUpdated = new Date(mongoCache.reviewsLastUpdated || mongoCache.lastUpdated);
      const areReviewsStale = now.getTime() - reviewsLastUpdated.getTime() > REVIEWS_TTL_MS;
      if (isCoreStale || areReviewsStale) {
        refreshGoogleDataInBackground(facility, REDIS_KEY);
      }

      return {
        googleName: mongoCache.googleName ?? null,
        rating: mongoCache.rating ?? null,
        lat: mongoCache.lat ?? null,
        lng: mongoCache.lng ?? null,
        photos: photoUrls,
        reviews: mongoCache.reviews || [],
        hadCache: true,
        placeId: mongoCache.placeId || null, // ✅ Added placeId
      };
    }
  } catch (e) {
    // ignore and fallback to background
  }

  // Trigger background refresh immediately for first-time users
  refreshGoogleDataInBackground(facility, REDIS_KEY);

  // Quick placeholder response
  return {
    googleName: null,
    rating: null,
    lat: null,
    lng: null,
    photos: [],
    reviews: [],
    hadCache: false,
    placeId: null, // ✅ Added placeId
  };
}



// Get Facility Details
// ✅ Get Facility Details (Type-safe & Stable)
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
    };

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
    res.json({
      ...facility,
      googleName: googleData.googleName ?? null,
      rating: googleData.rating ?? null,
      photos: googleData.photos ?? [],
      reviews: googleData.reviews ?? [],
      lat: googleData.lat ?? null,
      lng: googleData.lng ?? null,
      aiSummary,
    });
  } catch (err) {
    console.error("❌ Error in getFacilityDetails:", err);
    next(err);
  }
};


// ✅ Get Top 10 Highest Rated Nursing Facilities (for Home Page)
// ✅ Fetch and store Google data (no AI)
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


// ✅ Detect ZIP / State / City
function normalizeQuery(q: string): { type: "zip" | "state" | "city"; value: string } {
  const cleanQ = q.trim().toLowerCase();
  const zipRegex = /^\d{5}$/;

  if (zipRegex.test(cleanQ)) return { type: "zip", value: cleanQ };

  const stateMatch = Object.keys(stateToAbbr).find(
    (state) => state.toLowerCase() === cleanQ || state.toLowerCase().startsWith(cleanQ)
  );

  if (stateMatch) return { type: "state", value: stateToAbbr[stateMatch] };

  return { type: "city", value: q };
}


type FacilityType = any; 

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

//     // -----------------------------
//     // 1️⃣ Redis Cache
//     // -----------------------------
//     const cachedRedis = await getCache(pageCacheKey);
//     if (cachedRedis) {
//       const parsed = JSON.parse(cachedRedis);
//       if (!parsed.data?.length) {
//         await deleteCache(pageCacheKey);
//       } else {
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
//     let totalCount = 0; // ✅ Fixed: renamed to avoid conflict

//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);

//       // ✅ Define pipeline with explicit typing
//       const pipeline: PipelineStage[] = [
//         {
//           $geoNear: {
//             near: { type: "Point", coordinates: [longitude, latitude] },
//             distanceField: "distance_m",
//             distanceMultiplier: 0.001, // Convert meters to kilometers
//             maxDistance: 50000, // 50km in meters
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

//       // ✅ Aggregate with Mongoose
//       facilities = await NursingFacility.aggregate(pipeline);
      
//       // ✅ Get total count for geo query
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
//         console.log("normalizedZip ZIP:", normalizedZip);

//         // Case 1: ZIP found in DB
//         let zipTotal = await NursingFacility.countDocuments({ zip_code: normalizedZip });
//         console.log("Initial ZIP count:", zipTotal);
        
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

//           // ✅ Continue with Google enrichment for ZIP results
//         } else {
//           // Case 2: ZIP not in DB -> Get coords from Google and find nearby
//           try {
//             const placeName = `${normalizedZip}, USA`;
//             const { lat, lng } = await getCoordinatesByPlaceName(placeName);
//             console.log("Google Coordinates:", { lng, lat });
//             console.log('allowed states', allowedAbbr);
            
//             facilities = await NursingFacility.find({
//               geoLocation: {
//                 $near: {
//                   $geometry: { type: "Point", coordinates: [lng, lat] },
//                   $maxDistance: 50000, // 50 km radius
//                 },
//               },
//               state: { $in: allowedAbbr },
//             })
//               .limit(limitNum)
//               .lean();
              
//             console.log("Found nearby facilities:", facilities.length);
//             totalCount = facilities.length; // For nearby search, total is the actual count

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

//             // Cache the nearby results
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
//         // Check if city exists in allowed states
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
 
//     // -----------------------------
//     // 5️⃣ Google + AI Enrichment
//     // -----------------------------
//     const googleResults = await Promise.all(
//       facilities.map((f) => getGoogleDataFast(f))
//     );
    
//     const reviewsTexts = facilities.map((_: any, i: number) =>
//       googleResults[i]?.reviews?.length
//         ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//         : ""
//     );
    
//     const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//     const pagedResults = facilities.map((f: any, i: number) => {
//       const gd = googleResults[i] ?? {};
//       return {
//         ...f,
//         googleName: gd.googleName ?? null,
//         rating: gd.rating ?? null,
//         photo: gd.photos?.[0] || null, // ✅ Fixed: use first photo reference
//         lat: gd.lat ?? f.latitude ?? null, // ✅ Fallback to original lat
//         lng: gd.lng ?? f.longitude ?? null, // ✅ Fallback to original lng
//         aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//       };
//     });

//     const responseData = {
//       data: pagedResults,
//       total: totalCount, // ✅ Fixed: use totalCount instead of total
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: pageNum <= 6 ? "db" : "db+google+ai",
//     };

//     // -----------------------------
//     // 6️⃣ Cache Non-Empty Results
//     // -----------------------------
//     if (responseData.data.length) {
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

    // -----------------------------
    // 1️⃣ Redis Cache
    // -----------------------------
    const cachedRedis = await getCache(pageCacheKey);
    if (cachedRedis) {
      const parsed = JSON.parse(cachedRedis);
      if (!parsed.data?.length) {
        await deleteCache(pageCacheKey);
      } else {
        return res.status(200).json({ ...parsed, cached: true, from: "redis" });
      }
    }

    // -----------------------------
    // 2️⃣ Mongo Cache Collection
    // -----------------------------
    const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
    if (mongoCache) {
      if (!mongoCache.data?.data?.length) {
        await CachedSearchResult.deleteOne({ key: pageCacheKey });
      } else {
        await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
        return res
          .status(200)
          .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
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

    // -----------------------------
    // 3️⃣ Query Main Database
    // -----------------------------
    let mongoQuery: any = {};
    let facilities: any[] = [];
    let totalCount = 0;

    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

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
          },
        },
        {
          $count: "total"
        }
      ];
      
      const totalResult = await NursingFacility.aggregate(totalPipeline);
      totalCount = totalResult[0]?.total || 0;

    } else if (q) {
      // Text-based search
      const cleanedQuery = q.replace(/_/g, " ").trim();
      const { type, value } = normalizeQuery(cleanedQuery);

      if (type === "zip") {
        const zipNumber = parseInt(value, 10);
        if (isNaN(zipNumber)) {
          return res.status(400).json({ error: `Invalid ZIP code "${value}".` });
        }

        const normalizedZip = zipNumber.toString().padStart(5, "0");
        console.log("normalizedZip ZIP:", normalizedZip);

        let zipTotal = await NursingFacility.countDocuments({ zip_code: normalizedZip });
        console.log("Initial ZIP count:", zipTotal);
        
        if (zipTotal > 0) {
          const facilityZip = await NursingFacility.findOne({ zip_code: normalizedZip }).select("state").lean();
          console.log("Facility ZIP state:", facilityZip?.state);

          const zipStateNormalized = facilityZip?.state?.trim().toUpperCase() || null;
          if (!zipStateNormalized || !allowedAbbr.includes(zipStateNormalized)) {
            return res.status(400).json({
              error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
            });
          }

          mongoQuery = { zip_code: normalizedZip, state: zipStateNormalized };
          facilities = await NursingFacility.find(mongoQuery)
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean();

          totalCount = await NursingFacility.countDocuments(mongoQuery);

        } else {
          try {
            const placeName = `${normalizedZip}, USA`;
            const { lat, lng } = await getCoordinatesByPlaceName(placeName);
            console.log("Google Coordinates:", { lng, lat });
            console.log('allowed states', allowedAbbr);
            
            facilities = await NursingFacility.find({
              geoLocation: {
                $near: {
                  $geometry: { type: "Point", coordinates: [lng, lat] },
                  $maxDistance: 50000,
                },
              },
              state: { $in: allowedAbbr },
            })
              .limit(limitNum)
              .lean();
              
            console.log("Found nearby facilities:", facilities.length);
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
            console.error("Google Geocode Error:", err.message);
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

        mongoQuery = { state: abbr };
        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();
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

        mongoQuery = { city_town: new RegExp(`^${value}$`, "i") };
        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();
      } else {
        mongoQuery = {
          $or: [
            { city_town: new RegExp(value, "i") },
            { provider_name: new RegExp(value, "i") },
            { zip_code: new RegExp(value, "i") },
          ],
          state: { $in: allowedAbbr },
        };

        totalCount = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();
      }
    }

    // -----------------------------
    // 4️⃣ Empty Result Handling
    // -----------------------------
    if (!facilities.length) {
      await deleteCache(pageCacheKey);
      await CachedSearchResult.deleteOne({ key: pageCacheKey });

      return res.status(200).json({
        data: [],
        total: 0,
        page: pageNum,
        limit: limitNum,
        cached: false,
        from: "db",
      });
    }
 
    // -----------------------------
    // 5️⃣ Google + AI Enrichment
    // -----------------------------
    const googleResults = await Promise.all(
      facilities.map((f) => getGoogleDataFast(f))
    );
    
    const reviewsTexts = facilities.map((_: any, i: number) =>
      googleResults[i]?.reviews?.length
        ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
        : ""
    );
    
    const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

    // -----------------------------
    // 🖼️ 6️⃣ Image Caching Integration
    // -----------------------------
    const facilitiesWithCachedPhotos = await Promise.all(
      facilities.map(async (f: any, i: number) => {
        const gd = googleResults[i] ?? {};
        const photoRefs = gd.photos || [];
        
        // Get cached photo URLs for this facility
        let cachedPhotoUrls: string[] = [];
        
        if (photoRefs.length > 0) {
          try {
            // Use batch caching for better performance
            cachedPhotoUrls = await Promise.all(
              photoRefs.slice(0, 4).map((photoRef: string) => 
                getCachedPhotoUrl(photoRef, 600, f._id?.toString(), gd.placeId)
              )
            );
            
            // Filter out null values
            cachedPhotoUrls = cachedPhotoUrls.filter(url => url !== null) as string[];
          } catch (error) {
            console.error(`Error caching photos for facility ${f._id}:`, error);
          }
        }

        return {
          ...f,
          googleName: gd.googleName ?? null,
          rating: gd.rating ?? null,
          photos: cachedPhotoUrls, // Now returns cached photo URLs instead of references
          photoRefs: photoRefs, // Keep original references for future caching
          lat: gd.lat ?? f.latitude ?? null,
          lng: gd.lng ?? f.longitude ?? null,
          aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
          googlePlaceId: gd.placeId || null,
        };
      })
    );

    // -----------------------------
    // 7️⃣ Batch Cache Photos for Next Requests (Non-blocking)
    // -----------------------------
    if (pageNum <= 3) { // Only pre-cache for first few pages
      const facilitiesForBatchCache = facilities.map((f: any, i: number) => {
        const gd = googleResults[i] ?? {};
        return {
          id: f._id?.toString(),
          photoRefs: gd.photos || [],
          googlePlaceId: gd.placeId
        };
      }).filter(f => f.photoRefs.length > 0);

      if (facilitiesForBatchCache.length > 0) {
        // Cache in background without awaiting
        batchCacheFacilityPhotos(facilitiesForBatchCache, 600)
          .then(results => {
            console.log(`🔄 Background cached ${Array.from(results.values()).flat().length} photos for ${results.size} facilities`);
          })
          .catch(error => {
            console.error('Background photo caching error:', error);
          });
      }
    }

    const responseData = {
      data: facilitiesWithCachedPhotos,
      total: totalCount,
      page: pageNum,
      limit: limitNum,
      cached: false,
      from: pageNum <= 6 ? "db" : "db+google+ai",
      imageCacheInfo: {
        cachedPhotos: facilitiesWithCachedPhotos.reduce((count, facility) => count + facility.photos.length, 0),
        totalPhotoRefs: facilitiesWithCachedPhotos.reduce((count, facility) => count + facility.photoRefs.length, 0)
      }
    };

    // -----------------------------
    // 8️⃣ Cache Non-Empty Results
    // -----------------------------
    if (responseData.data.length) {
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
//       limit,
//     } = req.query as any;

//     const pipeline: any[] = [];
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
//         const fromCoords = await googleService.getCoordinatesByPlaceName(
//           fromLocation.replace(/_/g, " ")
//         );
//         const toCoords = await googleService.getCoordinatesByPlaceName(
//           toLocation.replace(/_/g, " ")
//         );

//         // Haversine formula
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

//     // 🧭 3️⃣ LOCATION NAME SEARCH (Reverted to Geocoding for proximity search)
//     else if (locationName) {
//       isGeoSearch = true;
//       try {
//         const coords = await googleService.getCoordinatesByPlaceName(
//           locationName.replace(/_/g, " ")
//         );
//         finalLat = coords.lat;
//         finalLng = coords.lng;
//         finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
//       } catch (err: any) {
//         console.error("Google locationName error:", err);
//         // This is the error return path if Google Geocoding fails to find the place name
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

//     // 🌎 7️⃣ GEO FILTER (optional)
//     if (isGeoSearch && finalLat && finalLng) {
//       pipeline.push({
//         $geoNear: {
//           near: { type: "Point", coordinates: [finalLng, finalLat] },
//           distanceField: "distance_m",
//           key: "geoLocation",
//           maxDistance: (finalDistanceKm || 20) * 1000, // meters
//           spherical: true,
//           query: matchQuery,
//         },
//       });
//     } else {
//       // This path is taken for City/State/Zip filters, Beds filters, or if locationName was provided but geo-search couldn't be performed (e.g., if there was no distanceKm or the user provided locationName was not found and we didn't want to show an error yet)
//       pipeline.push({ $match: matchQuery });
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
//     }

//     // 🔢 9️⃣ APPLY LIMIT (default 50)
//     const resultsLimit = limit ? parseInt(limit) : 10;
//     pipeline.push({ $limit: resultsLimit });

//     // 🚀 EXECUTE QUERY
//     const facilities = await Facility.aggregate(pipeline);
//     console.log(`✅ Found ${facilities.length} facilities (limited to ${resultsLimit})`);

//     // 🧠 GOOGLE PLACE DATA
//     const googleResults = await Promise.all(
//       facilities.map((f: any) => fetchAndCacheGoogleData(f))
//     );

//     const finalResults = facilities.map((f: any, i: number) => {
//       const g = googleResults[i];
//       return {
//         ...f,
//         distance_km: f.distance_m ? f.distance_m / 1000 : null,
//         googleName: g?.googleName,
//         rating: g?.rating,
//         photo: g?.photos?.[0] || null,
//         lat: g?.lat || f.latitude,
//         lng: g?.lng || f.longitude,
//         aiSummary: { summary: "", pros: [], cons: [] },
//       };
//     });

//     // 📦 RESPONSE
//     const response: any = { facilities: finalResults };
//     if (fromLocation && toLocation) {
//       response.fromLocation = fromLocation;
//       response.toLocation = toLocation;
//       response.fromToDistanceKm = fromToDistanceKm;
//     } else if (isGeoSearch && finalLat && finalLng) {
//       response.centerCoords = { lat: finalLat, lng: finalLng };
//     }

//     res.json(response);
//   } catch (err) {
//     console.error("❌ Error in filterFacilitiesWithReviews:", err);
//     res.status(500).json({ message: "Internal server error." });
//   }
// };


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
//       page = 1,
//       limit = 8,
//     } = req.query as any;

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
//       page: parseInt(page),
//       limit: parseInt(limit),
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
//         const fromCoords = await googleService.getCoordinatesByPlaceName(
//           fromLocation.replace(/_/g, " ")
//         );
//         const toCoords = await googleService.getCoordinatesByPlaceName(
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
//         const coords = await googleService.getCoordinatesByPlaceName(
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
//     const pageNum = parseInt(page);
//     const limitNum = parseInt(limit);
//     const skip = (pageNum - 1) * limitNum;

//     // Get total count
//     countPipeline.push({ $count: "totalCount" });
//     const countResult = await Facility.aggregate(countPipeline);
//     const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
//     const totalPages = Math.ceil(totalCount / limitNum);

//     // Apply pagination to main pipeline
//     pipeline.push({ $skip: skip });
//     pipeline.push({ $limit: limitNum });

//     console.log(`📊 Filtered Pagination: Page ${pageNum}, Total: ${totalCount}`);

//     // 🚀 EXECUTE QUERY
//     const facilities = await Facility.aggregate(pipeline);

//     // 🧠 GOOGLE PLACE DATA
//     const googleResults = await Promise.all(
//       facilities.map((f: any) => fetchAndCacheGoogleData(f))
//     );

//     const finalResults = facilities.map((f: any, i: number) => {
//       const g = googleResults[i];
//       return {
//         ...f,
//         distance_km: f.distance_m ? f.distance_m / 1000 : null,
//         googleName: g?.googleName,
//         rating: g?.rating,
//         photo: g?.photos?.[0] || null,
//         lat: g?.lat || f.latitude,
//         lng: g?.lng || f.longitude,
//         aiSummary: { summary: "", pros: [], cons: [] },
//       };
//     });

//     // 📦 BUILD RESPONSE
//     const response: any = { 
//       facilities: finalResults,
//       pagination: {
//         currentPage: pageNum,
//         totalPages: totalPages,
//         totalCount: totalCount,
//         hasNextPage: pageNum < totalPages,
//         hasPrevPage: pageNum > 1,
//         limit: limitNum
//       }
//     };
    
//     if (fromLocation && toLocation) {
//       response.fromLocation = fromLocation;
//       response.toLocation = toLocation;
//       response.fromToDistanceKm = fromToDistanceKm;
//     } else if (isGeoSearch && finalLat && finalLng) {
//       response.centerCoords = { lat: finalLat, lng: finalLng };
//     }

//     // 💾 CACHE THE RESULTS
//     try {
//       // Cache in Redis
//       await setCache(pageCacheKey, JSON.stringify({ data: response }), ONE_YEAR_MS);
      
//       // Cache in MongoDB
//       await CachedSearchResult.findOneAndUpdate(
//         { key: pageCacheKey },
//         { 
//           key: pageCacheKey,
//           data: { data: response },
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

//     res.json(response);
//   } catch (err) {
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
    const countPipeline: any[] = [];
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

    // 🌎 7️⃣ GEO FILTER
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
      
      countPipeline.push({
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
      countPipeline.push({ $match: matchQuery });
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
      
      countPipeline.push({
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
      
      countPipeline.push({
        $match: { numeric_overall_rating: { $gte: ratingMinNum } },
      });
    }

    // 🔢 9️⃣ PAGINATION
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    countPipeline.push({ $count: "totalCount" });
    const countResult = await NursingFacility.aggregate(countPipeline);
    const totalCount = countResult.length > 0 ? countResult[0].totalCount : 0;
    const totalPages = Math.ceil(totalCount / limitNum);

    // Apply pagination to main pipeline
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    console.log(`📊 Filtered Pagination: Page ${pageNum}, Total: ${totalCount}`);

    // 🚀 EXECUTE QUERY
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