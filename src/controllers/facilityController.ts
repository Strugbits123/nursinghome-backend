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
import { summarizeReviews, summarizeReviewsBatch, SummarizeResult } from "../services/aiService";
import Facility from "../models/NursingFacility"; 
import { getCache, setCache, deleteCache } from "../config/redisClient";
import CachedSearchResult from "../models/CachedSearchResult";
import NursingFacility from "../models/NursingFacility";



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


// const fetchAndCacheGoogleData = async (facility: any) => {
//     const cache = facility.googleCache;
//     const now = new Date();
//     const CACHE_LIFETIME = 30 * 24 * 60 * 60 * 1000;

//     // 💡 CACHE CHECK: If cache is fresh, return it immediately
//     if (cache && cache.lastUpdated && (now.getTime() - cache.lastUpdated.getTime()) < CACHE_LIFETIME) {
//         // Return array of photos and reviews from cache
//         const photoUrls = cache.photoReferences.map((ref: string) => googleService.getPhotoUrl(ref));
        
//         return {
//             googleName: cache.googleName,
//             rating: cache.rating,
//             lat: cache.lat,
//             lng: cache.lng,
//             photos: photoUrls, // Multiple photos from cache
//             reviews: cache.reviews, // Reviews from cache
//         };
//     }

//     // Cache is missing or stale, proceed with expensive API calls
//     try {
//         let placeId =
//             (await googleService.findPlaceIdByText(facility.provider_name)) ||
//             (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.zip_code}`)) ||
//             (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.city_town}`));

//         if (placeId) {
//             const details = await googleService.getPlaceDetails(placeId);
//             if (details) {
//                 // 💡 NEW LOGIC: Get top 4 photo references and all reviews
//                 const photoReferences = details.photos 
//                     ? details.photos.slice(0, 4).map((p: any) => p.photo_reference) 
//                     : [];
//                 const photoUrls = photoReferences.map((ref: string) => googleService.getPhotoUrl(ref));
//                 const reviews = details.reviews || [];

//                 const newCache = {
//                     placeId,
//                     googleName: details.name,
//                     rating: details.rating,
//                     lat: details.lat,
//                     lng: details.lng,
//                     photoReferences, // Store array of references
//                     reviews, // Store array of reviews
//                     lastUpdated: now
//                 };
                
//                 // Update MongoDB document in the background
//                 Facility.findOneAndUpdate(
//                     { _id: facility._id }, 
//                     { $set: { googleCache: newCache } }
//                 ).exec().catch(err => console.error(`Cache update failed for ${facility._id}:`, err));

//                 return {
//                     googleName: newCache.googleName,
//                     rating: newCache.rating,
//                     lat: newCache.lat,
//                     lng: newCache.lng,
//                     photos: photoUrls,
//                     reviews: reviews, 
//                   };
//             }
//         }
//     } catch (err) {
//         console.error(`Google fetch failed for ${facility.provider_name}:`, err);
//     }

//     return { googleName: null, rating: null, lat: null, lng: null, photos: [], reviews: [] };
// };



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


// ⚡ Fast, non-blocking Google data fetch: returns cached data immediately,
// triggers background refresh when stale/missing.
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

// ✅ Detects query type and normalizes state names

// function normalizeQuery(q: string): { type: "zip" | "state" | "city"; value: string } {
//   const cleanQ = q.trim().toLowerCase();
//   const zipRegex = /^\d{5}$/;
//   if (zipRegex.test(cleanQ)) {
//     console.log("🔍 Query detected as ZIP:", cleanQ);
//     return { type: "zip", value: cleanQ };
//   }

//   // Check full state name exact or starts with partial
//   const stateMatch = Object.keys(stateToAbbr).find(state =>
//     state.toLowerCase() === cleanQ || state.toLowerCase().startsWith(cleanQ)
//   );

//   if (stateMatch) {
//     console.log(`🔍 Query detected as STATE: "${q}" → Abbreviation: "${stateToAbbr[stateMatch]}"`);
//     return { type: "state", value: stateToAbbr[stateMatch] };
//   }

//   console.log("🔍 Query detected as CITY:", q);
//   return { type: "city", value: q };
// }

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




// New Code

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

//     // -----------------------------
//     // Base and page cache keys
//     // -----------------------------
//     const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
//     const pageCacheKey = `${baseCacheKey}&page${pageNum}`;

//     // Check page-level cache first
//     const cachedPage = await getCache(pageCacheKey);
//     if (cachedPage) {
//       console.log(`✅ CACHE HIT for ${pageCacheKey}`);
//       return res.status(200).json({ ...JSON.parse(cachedPage), cached: true, from: "page-cache" });
//     }

//     // -----------------------------
//     // Load facilities from DB
//     // -----------------------------
//     let facilities: any[] = [];
//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);
//       facilities = await Facility.find({
//         geoLocation: {
//           $near: {
//             $geometry: { type: "Point", coordinates: [longitude, latitude] },
//             $maxDistance: 50000,
//           },
//         },
//       }).lean();
//     } else if (q) {
//       const { type, value } = normalizeQuery(q.trim());
//       const mongoQuery: any = {};
//       if (type === "zip") mongoQuery.zip_code = value;
//       else if (type === "state") mongoQuery.state = new RegExp(`^${value}$`, "i");
//       else mongoQuery.city_town = new RegExp(value, "i");
//       facilities = await Facility.find(mongoQuery).lean();
//     }

//     const totalFacilities = facilities.length;
//     if (totalFacilities === 0) return res.status(200).json({ data: [], total: 0 });

//     // -----------------------------
//     // Pagination slice
//     // -----------------------------
//     const start = (pageNum - 1) * limitNum;
//     const end = pageNum * limitNum;
//     const pagedFacilities = facilities.slice(start, end);

//     // -----------------------------
//     // Google + AI enrichment logic
//     // -----------------------------
//     let pagedResults: any[] = [];

//     // **Pages 1–6:** Preload Google+AI in background for first 48 items
//     if (pageNum <= 6) {
//       pagedResults = pagedFacilities.map(f => ({
//         ...f,
//         googleName: null,
//         rating: null,
//         photo: null,
//         lat: null,
//         lng: null,
//         aiSummary: { summary: "", pros: [], cons: [] },
//       }));

//       // Cache each page
//       await setCache(pageCacheKey, JSON.stringify({ data: pagedResults, total: totalFacilities }), ONE_YEAR_MS);

//       // Background fetch for Google+AI (async)
//       (async () => {
//         try {
//           const first48 = facilities.slice(0, 48);
//           const googleResults = await Promise.all(first48.map(f => getGoogleDataFast(f)));
//           const reviewsTexts = first48.map((_, i) =>
//             googleResults[i]?.reviews?.length 
//             ? googleResults[i].reviews.map((r: { text: string }) => r.text).join("\n") 
//             : ""
//           );
//           const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//           for (let p = 1; p <= 6; p++) {
//             const pageStart = (p - 1) * limitNum;
//             const pageEnd = pageStart + limitNum;
//             const pageData = first48.slice(pageStart, pageEnd).map((f, i) => {
//               const gd = googleResults[pageStart + i] ?? {};
//               return {
//                 ...f,
//                 googleName: gd.googleName ?? null,
//                 rating: gd.rating ?? null,
//                 photo: gd.photos?.[0] || null,
//                 lat: gd.lat ?? null,
//                 lng: gd.lng ?? null,
//                 aiSummary: aiSummaries[pageStart + i] || { summary: "", pros: [], cons: [] },
//               };
//             });
//             const key = `${baseCacheKey}&page${p}`;
//             await setCache(key, JSON.stringify({ data: pageData, total: totalFacilities }), ONE_YEAR_MS);
//             console.log(`💾 Cached Google+AI for page ${p}`);
//           }
//         } catch (err) {
//           console.error("❌ Background enrichment error:", err);
//         }
//       })();

//     } else {
//       // **Pages 7+:** Fetch Google+AI only for this page
//       const googleResults = await Promise.all(pagedFacilities.map(f => getGoogleDataFast(f)));
//       const reviewsTexts = pagedFacilities.map((_, i) =>
//        googleResults[i]?.reviews?.length 
//         ? googleResults[i].reviews.map((r: { text: string }) => r.text).join("\n") 
//         : ""
//       );
      
//       const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//       pagedResults = pagedFacilities.map((f, i) => {
//         const gd = googleResults[i] ?? {};
//         return {
//           ...f,
//           googleName: gd.googleName ?? null,
//           rating: gd.rating ?? null,
//           photo: gd.photos?.[0] || null,
//           lat: gd.lat ?? null,
//           lng: gd.lng ?? null,
//           aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//         };
//       });

//       await setCache(pageCacheKey, JSON.stringify({ data: pagedResults, total: totalFacilities }), ONE_YEAR_MS);
//       console.log(`💾 Cached Google+AI for page ${pageNum}`);
//     }

//     // -----------------------------
//     // Return paged results
//     // -----------------------------
//     return res.status(200).json({
//       data: pagedResults,
//       total: totalFacilities,
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: pageNum <= 6 ? "db" : "db+google+ai",
//     });

//   } catch (err: any) {
//     console.error("❌ API error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };


type FacilityType = any; 









// export const searchFacilitiesWithReviews = async (
// req: Request,
// res: Response,
// next: NextFunction
// ) => {
// try {
// const { lat, lng, q, page = "1", limit = "8" } = req.query as {
// lat?: string;
// lng?: string;
// q?: string;
// page?: string;
// limit?: string;
// };

// const pageNum = parseInt(page);
// const limitNum = parseInt(limit);

// const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
// const pageCacheKey = `${baseCacheKey}&page:${pageNum}`;

// // -----------------------------
// // 1️⃣ Try Redis cache
// // -----------------------------
// const cachedRedis = await getCache(pageCacheKey);
// if (cachedRedis) {
//   console.log(`✅ Redis Cache HIT for ${pageCacheKey}`);
//   const parsed = JSON.parse(cachedRedis);
//   if (!parsed.data?.length) {
//     // ❌ Remove empty cache immediately
//     console.log(`🧹 Removing empty Redis cache for ${pageCacheKey}`);
//     await deleteCache(pageCacheKey);
//   } else {
//     return res.status(200).json({ ...parsed, cached: true, from: "redis" });
//   }
// }

// // -----------------------------
// // 2️⃣ Try Mongo Cache collection
// // -----------------------------
// const mongoCache = await CachedSearchResult.findOne({ key: pageCacheKey });
// if (mongoCache) {
//   console.log(`✅ Mongo Cache HIT for ${pageCacheKey}`);
//   if (!mongoCache.data?.data?.length) {
//     // ❌ Remove empty mongo cache
//     console.log(`🧹 Removing empty Mongo cache for ${pageCacheKey}`);
//     await CachedSearchResult.deleteOne({ key: pageCacheKey });
//   } else {
//     // Restore Redis for speed
//     await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
//     return res.status(200).json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
//   }
// }

// // -----------------------------
// // 3️⃣ Query Main DB
// // -----------------------------
// let facilities: any[] = [];

// if (lat && lng) {
//   const latitude = parseFloat(lat);
//   const longitude = parseFloat(lng);

//   facilities = await Facility.find({
//     geoLocation: {
//       $near: {
//         $geometry: { type: "Point", coordinates: [longitude, latitude] },
//         $maxDistance: 50000,
//       },
//     },
//     state: { $in: allowedAbbr },
//   })
//     .skip((pageNum - 1) * limitNum)
//     .limit(limitNum)
//     .lean();
// } else if (q) {
//   const { type, value } = normalizeQuery(q.trim());
//   const mongoQuery: any = {};

//   if (type === "zip") {
//     const stateOfZip = await Facility.findOne({ zip_code: value }).select("state").lean();
//     const zipState = stateOfZip?.state ?? null;

//     if (!zipState || !allowedAbbr.includes(zipState)) {
//       return res.status(400).json({
//         error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//       });
//     }

//     mongoQuery.zip_code = value;
//   } else if (type === "state") {
//     if (!allowedAbbr.includes(value)) {
//       return res.status(400).json({
//         error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//       });
//     }
//     mongoQuery.state = new RegExp(`^${value}$`, "i");
//   } else {
//     mongoQuery.$and = [
//       { $or: [{ city_town: new RegExp(value, "i") }, { name: new RegExp(value, "i") }] },
//       { state: { $in: allowedAbbr } },
//     ];
//   }

//   facilities = await Facility.find(mongoQuery)
//     .skip((pageNum - 1) * limitNum)
//     .limit(limitNum)
//     .lean();
// }

// const totalFacilities = facilities.length;

// // -----------------------------
// // 4️⃣ Remove empty cache entries if no data
// // -----------------------------
// if (totalFacilities === 0) {
//   console.log(`⚠️ No facilities found — removing any stale cache`);
//   await deleteCache(pageCacheKey);
//   await CachedSearchResult.deleteOne({ key: pageCacheKey });

//   return res.status(200).json({
//     data: [],
//     total: 0,
//     page: pageNum,
//     limit: limitNum,
//     cached: false,
//     from: "db",
//   });
// }

// // -----------------------------
// // 5️⃣ Google + AI enrichment
// // -----------------------------
// const googleResults = await Promise.all(facilities.map((f) => getGoogleDataFast(f)));
// const reviewsTexts = facilities.map((_: any, i: number) =>
//   googleResults[i]?.reviews?.length
//     ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//     : ""
// );
// const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

// const pagedResults = facilities.map((f: any, i: number) => {
//   const gd = googleResults[i] ?? {};
//   return {
//     ...f,
//     googleName: gd.googleName ?? null,
//     rating: gd.rating ?? null,
//     photo: gd.photos?.[0] || null,
//     lat: gd.lat ?? null,
//     lng: gd.lng ?? null,
//     aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//   };
// });

// const responseData = {
//   data: pagedResults,
//   total: totalFacilities,
//   page: pageNum,
//   limit: limitNum,
//   cached: false,
//   from: pageNum <= 6 ? "db" : "db+google+ai",
// };

// // -----------------------------
// // 6️⃣ Cache results only if non-empty
// // -----------------------------
// if (responseData.data.length > 0) {
//   await setCache(pageCacheKey, JSON.stringify(responseData), ONE_YEAR_MS);
//   await CachedSearchResult.updateOne(
//     { key: pageCacheKey },
//     { $set: { data: responseData } },
//     { upsert: true }
//   );
// }

// return res.status(200).json(responseData);


// } catch (err: any) {
// console.error("❌ API error:", err);
// res.status(500).json({ error: err.message });
// }
// };



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
//       console.log(`✅ Redis Cache HIT for ${pageCacheKey}`);
//       const parsed = JSON.parse(cachedRedis);
//       if (!parsed.data?.length) {
//         console.log(`🧹 Removing empty Redis cache for ${pageCacheKey}`);
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
//       console.log(`✅ Mongo Cache HIT for ${pageCacheKey}`);
//       if (!mongoCache.data?.data?.length) {
//         console.log(`🧹 Removing empty Mongo cache for ${pageCacheKey}`);
//         await CachedSearchResult.deleteOne({ key: pageCacheKey });
//       } else {
//         await setCache(pageCacheKey, JSON.stringify(mongoCache.data), ONE_YEAR_MS);
//         return res
//           .status(200)
//           .json({ ...mongoCache.data, cached: true, from: "mongo-cache" });
//       }
//     }

//     // -----------------------------
//     // 3️⃣ Query Main Database
//     // -----------------------------
//     let mongoQuery: any = {};
//     let facilities: any[] = [];
//     let total = 0;

//     if (lat && lng) {
//       // ✅ Geo-based search
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);

//       mongoQuery = {
//         geoLocation: {
//           $near: {
//             $geometry: { type: "Point", coordinates: [longitude, latitude] },
//             $maxDistance: 50000, // 50km
//           },
//         },
//         state: { $in: allowedAbbr },
//       };

//       total = await NursingFacility.countDocuments(mongoQuery);

//       facilities = await NursingFacility.find(mongoQuery)
//         .skip((pageNum - 1) * limitNum)
//         .limit(limitNum)
//         .lean();
//     } else if (q) {
//       // ✅ Text-based search
//       const cleanedQuery = q.replace(/_/g, " ").trim();
//       const { type, value } = normalizeQuery(cleanedQuery);

//       if (type === "zip") {
//         const stateOfZip = await NursingFacility.findOne({ zip_code: value })
//           .select("state")
//           .lean();
//         const zipState = stateOfZip?.state ?? null;

//         if (!zipState || !allowedAbbr.includes(zipState)) {
//           return res.status(400).json({
//             error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//           });
//         }

//         mongoQuery = { zip_code: value };
//       } else if (type === "state") {
//         const abbr = stateToAbbr[value] || value.toUpperCase();

//         if (!allowedAbbr.includes(abbr)) {
//           return res.status(400).json({
//             error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
//           });
//         }

//         mongoQuery = {
//           $or: [
//             { state: new RegExp(`^${abbr}$`, "i") },
//             { state: new RegExp(`^${value}$`, "i") },
//           ],
//         };
//       } else {
//         mongoQuery = {
//           $and: [
//             {
//               $or: [
//                 { city_town: new RegExp(value, "i") },
//                 { name: new RegExp(value, "i") },
//               ],
//             },
//             { state: { $in: allowedAbbr } },
//           ],
//         };
//       }

//       total = await NursingFacility.countDocuments(mongoQuery);

//       facilities = await NursingFacility.find(mongoQuery)
//         .skip((pageNum - 1) * limitNum)
//         .limit(limitNum)
//         .lean();
//     }

//     // -----------------------------
//     // 4️⃣ Empty Result Handling
//     // -----------------------------
//     if (facilities.length === 0) {
//       console.log(`⚠️ No facilities found — removing stale cache`);
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
//     const googleResults = await Promise.all(facilities.map((f) => getGoogleDataFast(f)));
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
//         photo: gd.photos?.[0] || null,
//         lat: gd.lat ?? null,
//         lng: gd.lng ?? null,
//         aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//       };
//     });

//     const responseData = {
//       data: pagedResults,
//       total,
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: pageNum <= 6 ? "db" : "db+google+ai",
//     };

//     // -----------------------------
//     // 6️⃣ Cache Non-Empty Results
//     // -----------------------------
//     if (responseData.data.length > 0) {
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
    let total = 0;

    if (lat && lng) {
      // Geo-based search
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);
      mongoQuery = {
        geoLocation: {
          $near: {
            $geometry: { type: "Point", coordinates: [longitude, latitude] },
            $maxDistance: 50000, // 50km
          },
        },
        state: { $in: allowedAbbr },
      };

      total = await NursingFacility.countDocuments(mongoQuery);

      facilities = await NursingFacility.find(mongoQuery)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();
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
      console.log("normalizedZip ZIP :", normalizedZip);

      let total = await NursingFacility.countDocuments({ zip_code: normalizedZip });
      console.log("Initial ZIP count:", total);
      // Case 1: ZIP found in DB
      if (total > 0) {
        const facilityZip = await NursingFacility.findOne({ zip_code: normalizedZip }).select("state").lean();
        console.log("Facility ZIP state:", facilityZip?.state);

        const zipStateNormalized = facilityZip?.state?.trim().toUpperCase() || null;
        if (!zipStateNormalized || !allowedAbbr.includes(zipStateNormalized)) {
          return res.status(400).json({
            error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
          });
        }

        const mongoQuery = { zip_code: normalizedZip, state: zipStateNormalized };
        const facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();

        total = await NursingFacility.countDocuments(mongoQuery);

        return res.json({
          total,
          facilities,
          message: `Found ${total} facility(s) for ZIP "${normalizedZip}".`,
        });
      }

      // Case 2: ZIP not in DB -> Get coords from Google and find nearby
      try {
      
        const placeName = `${normalizedZip}, USA`;
        const { lat, lng } = await getCoordinatesByPlaceName(placeName);
        console.log("Google Coordinates:", { lng, lat });
        console.log('allowed staedes', allowedAbbr);
        const nearbyFacilities = await NursingFacility.find({
          geoLocation: {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: 50000, // 50 km radius
            },
          },
          state: { $in: allowedAbbr },
        })
          .limit(limitNum)
          .lean();
          
        console.log("Found:", nearbyFacilities.length);

        return res.json({
          message: `ZIP code "${normalizedZip}" not Found.`,
          coordinates: { lat, lng },
          total: nearbyFacilities.length,
          facilities: nearbyFacilities,
        });
      } catch (err: any) {
        console.error("Google Geocode Error:", err.message);
        return res.status(400).json({
          error: `ZIP code "${normalizedZip}" not found in our database and Google lookup failed: ${err.message}`,
        });
      }


        //   let zipNumber = parseInt(value, 10);
        // if (isNaN(zipNumber)) {
        //   return res.status(400).json({ error: `Invalid ZIP code "${value}".` });
        // }

        // const normalizedZip = zipNumber.toString().padStart(5, "0");

        // total = await NursingFacility.countDocuments({ zip_code: normalizedZip });

        // if (!total) {
        //   try {
        //     const placeName = `${normalizedZip}, USA`;
        //     const { lat, lng } = await getCoordinatesByPlaceName(placeName);

        //     const nearbyFacilities = await NursingFacility.find({
        //       geoLocation: {
        //         $near: {
        //           $geometry: { type: "Point", coordinates: [lng, lat] },
        //           $maxDistance: 50000,
        //         },
        //       },
        //       state: { $in: allowedAbbr },
        //     })
        //       .limit(limitNum)
        //       .lean();

        //     return res.json({
        //       message: `ZIP code "${normalizedZip}" not found in our database. Showing nearby facilities based on Google coordinates.`,
        //       coordinates: { lat, lng },
        //       total: nearbyFacilities.length,
        //       facilities: nearbyFacilities,
        //     });
        //   } catch (err: any) {
        //     return res.status(400).json({
        //       error: `ZIP code "${normalizedZip}" not found in our database and Google lookup failed: ${err.message}`,
        //     });
        //   }
        // }

        // // ZIP exists in DB
        // const facilityZip = await NursingFacility.findOne({ zip_code: normalizedZip })
        //   .select("state")
        //   .lean();

        // const zipStateNormalized = facilityZip?.state?.trim().toUpperCase() || null;
        // if (!zipStateNormalized || !allowedAbbr.includes(zipStateNormalized)) {
        //   return res.status(400).json({
        //     error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
        //   });
        // }

        // mongoQuery = { zip_code: normalizedZip, state: zipStateNormalized };
        // facilities = await NursingFacility.find(mongoQuery)
        //   .skip((pageNum - 1) * limitNum)
        //   .limit(limitNum)
        //   .lean();

        // total = await NursingFacility.countDocuments(mongoQuery);

        // return res.json({
        //   total,
        //   facilities,
        //   message: `Found ${total} facility(s) for ZIP "${normalizedZip}".`,
        // });
      

        
      } else if (type === "state") {
        const abbr = stateToAbbr[value] || value.toUpperCase();
        if (!allowedAbbr.includes(abbr)) {
          return res.status(400).json({
            error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
          });
        }

        mongoQuery = { state: abbr };
        total = await NursingFacility.countDocuments(mongoQuery);
        facilities = await NursingFacility.find(mongoQuery)
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();
      } else if (type === "city") {
        // Check if city exists in allowed states
        const facilityInCity = await NursingFacility.findOne({ city_town: new RegExp(value, "i") })
          .select("state")
          .lean();

        if (!facilityInCity || !allowedAbbr.includes(facilityInCity.state ?? "")) {
          return res.status(400).json({
            error: `Sorry, we currently support searches only for ${allowedStates.join(", ")}.`,
          });
        }

        mongoQuery = { city_town: new RegExp(value, "i") };
        total = await NursingFacility.countDocuments(mongoQuery);
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

        total = await NursingFacility.countDocuments(mongoQuery);
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
    const googleResults = await Promise.all(facilities.map((f) => getGoogleDataFast(f)));
    const reviewsTexts = facilities.map((_: any, i: number) =>
      googleResults[i]?.reviews?.length
        ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
        : ""
    );
    const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

    const pagedResults = facilities.map((f: any, i: number) => {
      const gd = googleResults[i] ?? {};
      return {
        ...f,
        googleName: gd.googleName ?? null,
        rating: gd.rating ?? null,
        photo: gd.photos?.[0] || null,
        lat: gd.lat ?? null,
        lng: gd.lng ?? null,
        aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
      };
    });

    const responseData = {
      data: pagedResults,
      total, // total reflects all matching facilities for ZIP / state / city
      page: pageNum,
      limit: limitNum,
      cached: false,
      from: pageNum <= 6 ? "db" : "db+google+ai",
    };

    // -----------------------------
    // 6️⃣ Cache Non-Empty Results
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















// // -----------------------------
// // Search Controller
// // -----------------------------
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

//     if (!q && !(lat && lng))
//       return res.status(400).json({ message: "Missing search query" });

//     // -----------------------------
//     // PAGE CACHE KEY
//     // -----------------------------
//     const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
//     const pageCacheKey = `${baseCacheKey}&page${pageNum}`;

//     // -----------------------------
//     // 1️⃣ Return from page-level cache if exists
//     // -----------------------------
//     const cachedPage = await getCache(pageCacheKey);
//     if (cachedPage) {
//       return res.status(200).json({ ...JSON.parse(cachedPage), cached: true, from: "page-cache" });
//     }

//     // -----------------------------
//     // 2️⃣ Load facilities from MongoDB
//     // -----------------------------
//     let facilities: any[] = [];

//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);
//       facilities = await Facility.find({
//         geoLocation: {
//           $near: {
//             $geometry: { type: "Point", coordinates: [longitude, latitude] },
//             $maxDistance: 50000,
//           },
//         },
//       }).lean();
//     } else if (q) {
//       const { type, value } = normalizeQuery(q.trim());
//       console.log("🔹 Detected type:", type, "| Normalized value:", value);

//       const mongoQuery: any = {};
//       if (type === "zip") mongoQuery.zip_code = value;
//       else if (type === "state") mongoQuery.state = new RegExp(value, "i");
//       else mongoQuery.city_town = new RegExp(value, "i");

//       facilities = await Facility.find(mongoQuery).lean();
//     }

//     const total = facilities.length;
//     if (!total) return res.status(200).json({ data: [], total });

//     // -----------------------------
//     // 3️⃣ Determine slice for current page
//     // -----------------------------
//     const startIdx = (pageNum - 1) * limitNum;
//     const endIdx = pageNum * limitNum;
//     const pagedFacilities = facilities.slice(startIdx, endIdx);

//     // -----------------------------
//     // 4️⃣ Google + AI enrichment for current page
//     // -----------------------------
//     const googleResults = await Promise.all(
//       pagedFacilities.map(f => getGoogleDataFast(f))
//     );

//     const reviewsTexts = pagedFacilities.map((_, i) =>
//       googleResults[i]?.reviews?.length
//         ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//         : ""
//     );

//     const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//     const pagedResults = pagedFacilities.map((f, i) => {
//       const gd = googleResults[i] ?? {};
//       return {
//         ...f,
//         googleName: gd.googleName ?? null,
//         rating: gd.rating ?? null,
//         photo: gd.photos?.[0] || null,
//         lat: gd.lat ?? null,
//         lng: gd.lng ?? null,
//         aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//       };
//     });

//     // -----------------------------
//     // 5️⃣ Cache current page
//     // -----------------------------
//     await setCache(
//       pageCacheKey,
//       JSON.stringify({ data: pagedResults, total }),
//       ONE_YEAR_MS
//     );

//     // -----------------------------
//     // 6️⃣ Progressive caching: fetch remaining pages in background
//     // -----------------------------
//     (async () => {
//       try {
//         const totalPages = Math.ceil(total / limitNum);
//         for (let p = 1; p <= totalPages; p++) {
//           const pageKey = `${baseCacheKey}&page${p}`;
//           const cached = await getCache(pageKey);
//           if (cached) continue;

//           const s = (p - 1) * limitNum;
//           const e = p * limitNum;
//           const pageSlice = facilities.slice(s, e);

//           if (!pageSlice.length) continue;

//           const googleAll = await Promise.all(pageSlice.map(f => getGoogleDataFast(f)));
//           const allReviews = pageSlice.map((_, i) =>
//             googleAll[i]?.reviews?.length
//               ? googleAll[i].reviews.map((r: any) => r.text).join("\n")
//               : ""
//           );
//           const allSummaries = await summarizeReviewsBatch(allReviews);

//           const enriched = pageSlice.map((f, i) => {
//             const gd = googleAll[i] ?? {};
//             return {
//               ...f,
//               googleName: gd.googleName ?? null,
//               rating: gd.rating ?? null,
//               photo: gd.photos?.[0] || null,
//               lat: gd.lat ?? null,
//               lng: gd.lng ?? null,
//               aiSummary: allSummaries[i] || { summary: "", pros: [], cons: [] },
//             };
//           });

//           await setCache(pageKey, JSON.stringify({ data: enriched, total }), ONE_YEAR_MS);
//         }
//       } catch (err) {
//         console.error("❌ Progressive caching error:", err);
//       }
//     })();

//     // -----------------------------
//     // 7️⃣ Return current page
//     // -----------------------------
//     return res.status(200).json({
//       data: pagedResults,
//       total,
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: "db",
//     });

//   } catch (err: any) {
//     console.error("❌ API error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };












// Cached Data New Code
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
// // Only preload for first page request
//     if (q && pageNum === 1) {
//       const redisKey = `search:query:${q.toLowerCase()}`;
//       const raw = await getCache(redisKey);
//       if (raw) {
//         const cachedArray = JSON.parse(raw);
//         const total = cachedArray.length;

//         // Take first 6 pages
//         const endIdx = Math.min(limitNum * 6, total);
//         const firstSixPagesData = cachedArray.slice(0, endIdx);

//         // Cache each page individually
//         for (let p = 1; p <= 6; p++) {
//           const start = (p - 1) * limitNum;
//           const end = p * limitNum;
//           const pageData = cachedArray.slice(start, end);
//           const pageCacheKey = `facility:query:${q.toLowerCase()}&page${p}`;
//           await setCache(pageCacheKey, JSON.stringify({ data: pageData, total }), ONE_YEAR_MS);
//         }

//         return res.status(200).json({
//           data: firstSixPagesData,
//           total,
//           page: 1,
//           limit: limitNum,
//           cached: true,
//           pagesShown: 6, // indicate first 6 pages are sent
//           from: "redis-top",
//         });
//       }
//     }
    

//     // -----------------------------
//     // 1️⃣ Page-level cache key
//     // -----------------------------
//     const baseCacheKey = `facility:query:${q || `${lat},${lng}`}`;
//     const pageCacheKey = `${baseCacheKey}&page${pageNum}`;

//     const cachedPage = await getCache(pageCacheKey);
//     if (cachedPage) {
//       console.log(`✅ CACHE HIT for ${pageCacheKey}`);
//       const parsed = JSON.parse(cachedPage);
//       return res.status(200).json({ ...parsed, cached: true, from: "page-cache" });
//     }
//     console.log(`❌ CACHE MISS for ${pageCacheKey}`);

//     // -----------------------------
//     // 2️⃣ Load facilities from MongoDB
//     // -----------------------------
//     let facilities: any[] = [];
//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);
//       facilities = await Facility.find({
//         geoLocation: {
//           $near: {
//             $geometry: { type: "Point", coordinates: [longitude, latitude] },
//             $maxDistance: 50000,
//           },
//         },
//       }).lean();
//     } else if (q) {
//       const { type, value } = normalizeQuery(q.trim());
//       const mongoQuery: any = {};
//       if (type === "zip") mongoQuery.zip_code = value;
//       else if (type === "state") mongoQuery.state = new RegExp(`^${value}$`, "i");
//       else mongoQuery.city_town = new RegExp(value, "i");
//       facilities = await Facility.find(mongoQuery).lean();
//     }

//     if (!facilities.length) {
//       return res.status(200).json({ data: [], total: 0 });
//     }

//     // -----------------------------
//     // 3️⃣ Paginate DB results
//     // -----------------------------
//     const start = (pageNum - 1) * limitNum;
//     const end = pageNum * limitNum;
//     const pagedFacilities = facilities.slice(start, end);

//     // -----------------------------
//     // 4️⃣ Google + AI enrichment
//     // -----------------------------
//     const googleResults = await Promise.all(
//       pagedFacilities.map((f) => getGoogleDataFast(f))
//     );

//     const reviewsTexts = pagedFacilities.map((_, i) =>
//       googleResults[i]?.reviews?.length
//         ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//         : ""
//     );

//     const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//     const pagedResults = pagedFacilities.map((facility, i) => {
//       const gd = googleResults[i] ?? {};
//       return {
//         ...facility,
//         googleName: gd.googleName ?? null,
//         rating: gd.rating ?? null,
//         photo: gd.photos?.[0] || null,
//         lat: gd.lat ?? null,
//         lng: gd.lng ?? null,
//         aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//       };
//     });

//     // -----------------------------
//     // 5️⃣ Cache current page
//     // -----------------------------
//     await setCache(
//       pageCacheKey,
//       JSON.stringify({ data: pagedResults, total: facilities.length }),
//       ONE_YEAR_MS
//     );
//     console.log(`💾 Cached ${pageCacheKey}`);

//     // -----------------------------
//     // 6️⃣ Progressive background caching every 6 pages
//     // -----------------------------
//     if (pageNum % 6 === 0) {
//       console.log(`⚙️ Starting background caching for next 6 pages from page ${pageNum + 1}...`);

//       (async () => {
//         try {
//           const nextStart = pageNum;
//           const nextEnd = Math.min(pageNum + 6, Math.ceil(facilities.length / limitNum));
//           const allToFetch = facilities.slice(nextStart * limitNum, nextEnd * limitNum);

//           if (allToFetch.length === 0) {
//             console.log("✅ No more facilities left to cache in background.");
//             return;
//           }

//           console.log(
//             `⏳ Background fetching Google+AI for pages ${nextStart + 1}–${nextEnd} (${allToFetch.length} facilities)`
//           );

//           const googleAllResults = await Promise.all(allToFetch.map((f) => getGoogleDataFast(f)));
//           const allReviewsTexts = allToFetch.map((_, i) =>
//             googleAllResults[i]?.reviews?.length
//               ? googleAllResults[i].reviews.map((r: any) => r.text).join("\n")
//               : ""
//           );
//           const allSummaries = await summarizeReviewsBatch(allReviewsTexts);

//           const allFinalResults = allToFetch.map((f, i) => {
//             const gd = googleAllResults[i] ?? {};
//             return {
//               ...f,
//               googleName: gd.googleName ?? null,
//               rating: gd.rating ?? null,
//               photo: gd.photos?.[0] || null,
//               lat: gd.lat ?? null,
//               lng: gd.lng ?? null,
//               aiSummary: allSummaries[i] || { summary: "", pros: [], cons: [] },
//             };
//           });

//           for (let p = nextStart + 1; p <= nextEnd; p++) {
//             const startIdx = (p - 1 - nextStart) * limitNum;
//             const endIdx = startIdx + limitNum;
//             const pageData = allFinalResults.slice(startIdx, endIdx);

//             const nextPageKey = `${baseCacheKey}&page${p}`;
//             await setCache(nextPageKey, JSON.stringify({ data: pageData, total: facilities.length }), ONE_YEAR_MS);
//             console.log(`💾 Cached background page ${p} (${pageData.length} items)`);
//           }

//           console.log(`✅ Finished background caching for pages ${nextStart + 1}–${nextEnd}`);
//         } catch (err) {
//           console.error("❌ Progressive background caching error:", err);
//         }
//       })();
//     }

//     // -----------------------------
//     // 7️⃣ Return result
//     // -----------------------------
//     return res.status(200).json({
//       data: pagedResults,
//       total: facilities.length,
//       page: pageNum,
//       limit: limitNum,
//       cached: false,
//       from: "db",
//     });
//   } catch (err: any) {
//     console.error("❌ API error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };

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
//     const cacheKey = SEARCH_CACHE_KEY({ lat, lng, q });

//     // --- 1. Check Cache ---
//     const cached = await getCache(cacheKey);
//     if (cached) {
//       console.log(`✅ CACHE HIT for ${cacheKey}`);
//       const allData = JSON.parse(cached);
//       const start = (pageNum - 1) * limitNum;
//       const end = pageNum * limitNum;
//       const paged = allData.slice(start, end);

//       return res.status(200).json({
//         data: paged,
//         total: allData.length,
//         cached: true,
//       });
//     }

//     console.log(`❌ CACHE MISS for ${cacheKey}`);

//     // --- 2. Get Facilities from DB ---
//     let facilities: any[] = [];
//     if (lat && lng) {
//       const latitude = parseFloat(lat);
//       const longitude = parseFloat(lng);
//       facilities = await Facility.find({
//         geoLocation: {
//           $near: {
//             $geometry: { type: "Point", coordinates: [longitude, latitude] },
//             $maxDistance: 50000,
//           },
//         },
//       }).lean();
//     } else if (q) {
//       const { type, value } = normalizeQuery(q.trim());
//       const mongoQuery: any = {};
//       if (type === "zip") mongoQuery.zip_code = value;
//       else if (type === "state") mongoQuery.state = new RegExp(`^${value}$`, "i");
//       else mongoQuery.city_town = new RegExp(value, "i");
//       facilities = await Facility.find(mongoQuery).lean();
//     }

//     if (!facilities.length) {
//       return res.status(200).json({ data: [], total: 0 });
//     }

//     // --- 3. Paginate ---
//     const start = (pageNum - 1) * limitNum;
//     const end = pageNum * limitNum;
//     const pagedFacilities = facilities.slice(start, end);

//     // --- 4. Fetch Google + AI ---
//     let pagedResults: any[] = [];
//     if (pageNum < 6) {
//       // Fetch only per-page Google & AI data
//       const googleResults = await Promise.all(
//         pagedFacilities.map((f) => getGoogleDataFast(f))
//       );

//       const reviewsTexts = pagedFacilities.map((_, i) =>
//         googleResults[i]?.reviews?.length
//           ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//           : ""
//       );

//       const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//       pagedResults = pagedFacilities.map((facility, i) => {
//         const googleData = googleResults[i] ?? {};
//         return {
//           ...facility,
//           googleName: googleData.googleName ?? null,
//           rating: googleData.rating ?? null,
//           photo: googleData.photos?.[0] || null,
//           lat: googleData.lat ?? null,
//           lng: googleData.lng ?? null,
//           aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//         };
//       });
//     } else {
//       // Page >=6 → fetch per-page Google + AI, but trigger background full caching
//       const googleResults = await Promise.all(
//         pagedFacilities.map((f) => getGoogleDataFast(f))
//       );
//       const reviewsTexts = pagedFacilities.map((_, i) =>
//         googleResults[i]?.reviews?.length
//           ? googleResults[i].reviews.map((r: any) => r.text).join("\n")
//           : ""
//       );
//       const aiSummaries = await summarizeReviewsBatch(reviewsTexts);

//       pagedResults = pagedFacilities.map((facility, i) => {
//         const gd = googleResults[i] ?? {};
//         return {
//           ...facility,
//           googleName: gd.googleName ?? null,
//           rating: gd.rating ?? null,
//           photo: gd.photos?.[0] || null,
//           lat: gd.lat ?? null,
//           lng: gd.lng ?? null,
//           aiSummary: aiSummaries[i] || { summary: "", pros: [], cons: [] },
//         };
//       });

//       // Trigger background caching for full dataset
//       (async () => {
//         try {
//           const googleAllResults = await Promise.all(
//             facilities.map((f) => getGoogleDataFast(f))
//           );
//           const allReviewsTexts = facilities.map((_, i) =>
//             googleAllResults[i]?.reviews?.length
//               ? googleAllResults[i].reviews.map((r: any) => r.text).join("\n")
//               : ""
//           );
//           const allSummaries = await summarizeReviewsBatch(allReviewsTexts);
//           const allFinalResults = facilities.map((f, i) => {
//             const gd = googleAllResults[i] ?? {};
//             return {
//               ...f,
//               googleName: gd.googleName ?? null,
//               rating: gd.rating ?? null,
//               photo: gd.photos?.[0] || null,
//               lat: gd.lat ?? null,
//               lng: gd.lng ?? null,
//               aiSummary: allSummaries[i] || { summary: "", pros: [], cons: [] },
//             };
//           });
//           await setCache(cacheKey, JSON.stringify(allFinalResults), ONE_YEAR_MS);
//           console.log(`💾 Cached ${allFinalResults.length} results for ${cacheKey}`);
//         } catch (err) {
//           console.error("❌ Background caching error:", err);
//         }
//       })();
//     }

//     return res.status(200).json({
//       data: pagedResults,
//       total: facilities.length,
//       cached: false,
//     });
//   } catch (err) {
//     console.error("❌ Error in searchFacilitiesWithReviews:", err);
//     next(err);
//   }
// };

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
//        limit, 
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
//       console.log("🚀 Performing FROM-TO search...");

//       const fromCoords = await googleService.getCoordinatesByPlaceName(fromLocation);
//       const toCoords = await googleService.getCoordinatesByPlaceName(toLocation);

//       // Haversine formula
//       const R = 6371;
//       const dLat = ((toCoords.lat - fromCoords.lat) * Math.PI) / 180;
//       const dLon = ((toCoords.lng - fromCoords.lng) * Math.PI) / 180;
//       const a =
//         Math.sin(dLat / 2) ** 2 +
//         Math.cos((fromCoords.lat * Math.PI) / 180) *
//           Math.cos((toCoords.lat * Math.PI) / 180) *
//           Math.sin(dLon / 2) ** 2;
//       const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//       fromToDistanceKm = R * c;

//       finalLat = (fromCoords.lat + toCoords.lat) / 2;
//       finalLng = (fromCoords.lng + toCoords.lng) / 2;
//       finalDistanceKm = fromToDistanceKm / 2 + 50;
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
//       const coords = await googleService.getCoordinatesByPlaceName(locationName);
//       finalLat = coords.lat;
//       finalLng = coords.lng;
//       finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
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

//     // 🚀 EXECUTE QUERY (no limit)
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
//     next(err);
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
      limit,
    } = req.query as any;

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
        const fromCoords = await googleService.getCoordinatesByPlaceName(
          fromLocation.replace(/_/g, " ")
        );
        const toCoords = await googleService.getCoordinatesByPlaceName(
          toLocation.replace(/_/g, " ")
        );

        // Haversine formula
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

    // 🧭 3️⃣ LOCATION NAME SEARCH (Reverted to Geocoding for proximity search)
    else if (locationName) {
      isGeoSearch = true;
      try {
        const coords = await googleService.getCoordinatesByPlaceName(
          locationName.replace(/_/g, " ")
        );
        finalLat = coords.lat;
        finalLng = coords.lng;
        finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
      } catch (err: any) {
        console.error("Google locationName error:", err);
        // This is the error return path if Google Geocoding fails to find the place name
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

    // 🌎 7️⃣ GEO FILTER (optional)
    if (isGeoSearch && finalLat && finalLng) {
      pipeline.push({
        $geoNear: {
          near: { type: "Point", coordinates: [finalLng, finalLat] },
          distanceField: "distance_m",
          key: "geoLocation",
          maxDistance: (finalDistanceKm || 20) * 1000, // meters
          spherical: true,
          query: matchQuery,
        },
      });
    } else {
      // This path is taken for City/State/Zip filters, Beds filters, or if locationName was provided but geo-search couldn't be performed (e.g., if there was no distanceKm or the user provided locationName was not found and we didn't want to show an error yet)
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

    // 🔢 9️⃣ APPLY LIMIT (default 50)
    const resultsLimit = limit ? parseInt(limit) : 10;
    pipeline.push({ $limit: resultsLimit });

    // 🚀 EXECUTE QUERY
    const facilities = await Facility.aggregate(pipeline);
    console.log(`✅ Found ${facilities.length} facilities (limited to ${resultsLimit})`);

    // 🧠 GOOGLE PLACE DATA
    const googleResults = await Promise.all(
      facilities.map((f: any) => fetchAndCacheGoogleData(f))
    );

    const finalResults = facilities.map((f: any, i: number) => {
      const g = googleResults[i];
      return {
        ...f,
        distance_km: f.distance_m ? f.distance_m / 1000 : null,
        googleName: g?.googleName,
        rating: g?.rating,
        photo: g?.photos?.[0] || null,
        lat: g?.lat || f.latitude,
        lng: g?.lng || f.longitude,
        aiSummary: { summary: "", pros: [], cons: [] },
      };
    });

    // 📦 RESPONSE
    const response: any = { facilities: finalResults };
    if (fromLocation && toLocation) {
      response.fromLocation = fromLocation;
      response.toLocation = toLocation;
      response.fromToDistanceKm = fromToDistanceKm;
    } else if (isGeoSearch && finalLat && finalLng) {
      response.centerCoords = { lat: finalLat, lng: finalLng };
    }

    res.json(response);
  } catch (err) {
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