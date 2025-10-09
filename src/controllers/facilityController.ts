import { Request, Response, NextFunction } from "express";
// import Facility, { IFacility } from "../models/facilityModel";
import * as cmsService from "../services/cmsService";
import * as googleService from "../services/googleService";
import axios from "axios";
import { PlaceDetails,
  findPlaceIdByText,  
  getPlaceDetails, getCoordinatesByPlaceName } from "../services/googleService";
import { summarizeReviews, SummarizeResult } from "../services/aiService";
import Facility from "../models/NursingFacility"; 
import { getCache, setCache } from "../config/redisClient";



// Get your API key from environment variables


const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";

const SEARCH_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; 
const SEARCH_CACHE_KEY = (query: { lat?: string; lng?: string; q?: string }) => {
    if (query.lat && query.lng) {
        // Key for coordinates search (normalize to fixed decimal places for consistency)
        const lat = parseFloat(query.lat).toFixed(4);
        const lng = parseFloat(query.lng).toFixed(4);
        return `search:nearby:${lat}_${lng}`;
    }
    if (query.q) {
        // Key for text search (normalize query string)
        return `search:query:${query.q.trim().toLowerCase().replace(/\s+/g, '_')}`;
    }
    return 'search:invalid';
};

// export const searchFacilitiesWithReviews = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const { city, state, zip } = req.query as {
//       city?: string;
//       state?: string;
//       zip?: string;
//     };

//     // Mongo query
//     const query: any = {};
//     if (city) query.city = new RegExp(city, "i");
//     if (state) query.state = state.toUpperCase();
//     if (zip) query.zip = zip;

//     const facilities = await Facility.find(query).limit(10);

//     const results = [];
//     for (const f of facilities) {
//       let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] };
//       let photo: string | null = null;
//       let lat: number | null = null;
//       let lng: number | null = null;
//       let googleName: string | null = null;
//       let rating: number | null = null;

//       try {
//         // 🔹 Try multiple queries to get placeId
//         let placeId =
//           (await googleService.findPlaceIdByText(f.name)) ||
//           (await googleService.findPlaceIdByText(`${f.name} ${f.zip}`)) ||
//           (await googleService.findPlaceIdByText(`${f.name} ${f.city}`));

//         console.log("Searching Place:", f.name, "=> placeId:", placeId);

//         if (placeId) {
//           const details = await googleService.getPlaceDetails(placeId);
//           if (details) {
//             googleName = details.name;
//             rating = details.rating;
//             lat = details.lat;
//             lng = details.lng;

//             // first photo
//             if (details.photos.length) {
//               photo = googleService.getPhotoUrl(details.photos[0].photo_reference);
//             }

//             // summarize reviews via AI
//             // const reviewsText = details.reviews.map((r) => r.text).join("\n");
//             // if (reviewsText) {
//             //   aiSummary = await summarizeReviews(reviewsText);
//             // }
//           }
//         }
//       } catch (err) {
//         console.error(`Google fetch failed for ${f.name}:`, err);
//       }

//       results.push({
//         ...f.toObject(),
//         googleName,
//         rating,
//         photo,
//         lat,
//         lng,
//         aiSummary,
//       });
//     }

//     res.json(results);
//   } catch (err) {
//     next(err);
//   }
// };

const fetchAndCacheGoogleData = async (facility: any) => {
    const cache = facility.googleCache;
    const now = new Date();
    const CACHE_LIFETIME = 30 * 24 * 60 * 60 * 1000;

    // 💡 CACHE CHECK: If cache is fresh, return it immediately
    if (cache && cache.lastUpdated && (now.getTime() - cache.lastUpdated.getTime()) < CACHE_LIFETIME) {
        // Return array of photos and reviews from cache
        const photoUrls = cache.photoReferences.map((ref: string) => googleService.getPhotoUrl(ref));
        
        return {
            googleName: cache.googleName,
            rating: cache.rating,
            lat: cache.lat,
            lng: cache.lng,
            photos: photoUrls, // Multiple photos from cache
            reviews: cache.reviews, // Reviews from cache
        };
    }

    // Cache is missing or stale, proceed with expensive API calls
    try {
        let placeId =
            (await googleService.findPlaceIdByText(facility.provider_name)) ||
            (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.zip_code}`)) ||
            (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.city_town}`));

        if (placeId) {
            const details = await googleService.getPlaceDetails(placeId);
            if (details) {
                // 💡 NEW LOGIC: Get top 4 photo references and all reviews
                const photoReferences = details.photos 
                    ? details.photos.slice(0, 4).map((p: any) => p.photo_reference) 
                    : [];
                const photoUrls = photoReferences.map((ref: string) => googleService.getPhotoUrl(ref));
                const reviews = details.reviews || [];

                const newCache = {
                    placeId,
                    googleName: details.name,
                    rating: details.rating,
                    lat: details.lat,
                    lng: details.lng,
                    photoReferences, // Store array of references
                    reviews, // Store array of reviews
                    lastUpdated: now
                };
                
                // Update MongoDB document in the background
                Facility.findOneAndUpdate(
                    { _id: facility._id }, 
                    { $set: { googleCache: newCache } }
                ).exec().catch(err => console.error(`Cache update failed for ${facility._id}:`, err));

                return {
                    googleName: newCache.googleName,
                    rating: newCache.rating,
                    lat: newCache.lat,
                    lng: newCache.lng,
                    photos: photoUrls,
                    reviews: reviews, 
                  };
            }
        }
    } catch (err) {
        console.error(`Google fetch failed for ${facility.provider_name}:`, err);
    }

    return { googleName: null, rating: null, lat: null, lng: null, photos: [], reviews: [] };
};

// Get Facility Details
export const getFacilityDetails = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const { name } = req.query as { name: string };
        if (!name) {
            return res.status(400).json({ message: "Facility name is required." });
        }
        
        const safeName = name.trim();
        const firstWord = safeName.split(/\s+/)[0];
        const escapedPrefix = firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchPrefix = escapedPrefix;
        const facility = await Facility.findOne({
          provider_name: { $regex: `^${searchPrefix}`, $options: "i" }
        })
        .sort({ provider_name: 1 }) 
        .lean();

        if (!facility) {
          console.log(`[DETAIL DEBUG] No facilities found with prefix: ${searchPrefix}`);
          return res.status(404).json({ message: "Facility not found." });
        }
  
        
        const googleData = await fetchAndCacheGoogleData(facility);
        
        
        let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] }; 

        const reviewsText = googleData.reviews ? googleData.reviews.map((r: any) => r.text).join("\n") : "";

        if (reviewsText) {
            aiSummary = await summarizeReviews(reviewsText);
        }
        
        res.json({
            ...facility, 
            googleName: googleData.googleName,
            rating: googleData.rating,
            photos: googleData.photos,
            reviews: googleData.reviews,
            lat: googleData.lat,
            lng: googleData.lng,
            aiSummary,
        });

    } catch (err) {
        next(err); 
    }
};


// ✅ Map of states (Full Name → Abbreviation)
const stateToAbbr: Record<string, string> = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
  "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
  "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
  "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
  "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
  "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
  "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
  "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY"
};

// ✅ Detects query type and normalizes state names
function normalizeQuery(q: string): { type: "zip" | "state" | "city"; value: string } {
  const zipRegex = /^\d{5}$/; // 5-digit ZIP Code (like "07001")
  if (zipRegex.test(q)) return { type: "zip", value: q };

  // Check if full state name → convert to abbreviation
  const stateMatch = Object.keys(stateToAbbr).find(
    state => state.toLowerCase() === q.toLowerCase()
  );
  if (stateMatch) return { type: "state", value: stateToAbbr[stateMatch] };

  // Otherwise, treat as city
  return { type: "city", value: q };
}

// ✅ Controller
export const searchFacilitiesWithReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
     const { lat, lng, q } = req.query as { lat?: string; lng?: string; q?: string };
     const cacheKey = SEARCH_CACHE_KEY(req.query as { lat?: string; lng?: string; q?: string });

    // --- 1. REDIS CACHE CHECK ---
    if (cacheKey !== 'search:invalid') {
        const cachedResult = await getCache(cacheKey);
        if (cachedResult) {
            console.log(`✅ CACHE HIT for search key: ${cacheKey}`);
            return res.status(200).json(JSON.parse(cachedResult));
        }
        console.log(`❌ CACHE MISS for search key: ${cacheKey}`);
    }

    // ✅ Case 1: Search by coordinates (nearby)
    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);

      if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({ message: "Invalid coordinates" });
      }

      console.log("📍 Searching nearby facilities:", latitude, longitude);

      const nearbyFacilities = await Facility.find({
        geoLocation: {
          $near: {
            $geometry: { type: "Point", coordinates: [longitude, latitude] },
            $maxDistance: 50000, // 50km radius
          },
        },
      }).limit(50);

      // --- 2. CACHE SET FOR NEARBY SEARCH (30 DAYS) ---
      if (nearbyFacilities.length > 0) {
        await setCache(
            cacheKey, 
            JSON.stringify(nearbyFacilities), 
            SEARCH_CACHE_TTL_SECONDS
        );
      }
      return res.status(200).json(nearbyFacilities);
    }

    if (!q) {
      return res.status(400).json({ message: "Missing search query" });
    }

    const safeQuery = q.trim();
    const { type, value } = normalizeQuery(safeQuery);

    console.log("🔍 Detected:", type, "| Normalized Value:", value);

    const mongoQuery: any = {};

    if (type === "zip") {
      mongoQuery.zip_code = value;
    } else if (type === "state") {
      mongoQuery.state = new RegExp(`^${value}$`, "i");
    } else {
      mongoQuery.city_town = new RegExp(value, "i");
    }

    // Fetch facilities from MongoDB
    const facilities = await Facility.find(mongoQuery).lean();

    if (!facilities || facilities.length === 0) {
      return res.status(200).json([]);
    }

    // ✅ Fetch Google data in parallel
    const googleResults = await Promise.all(
      facilities.map((facility) => fetchAndCacheGoogleData(facility))
    );

    // ✅ Process AI summaries in parallel (safe)
    const finalResults = await Promise.all(
      facilities.map(async (facility, index) => {
        const googleData = googleResults[index];

        // Default structure
        let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] };

        // ✅ Extract review text safely
        const reviewsText = googleData.reviews
          ? googleData.reviews.map((r: any) => r.text).join("\n")
          : "";

        // ✅ Conditionally generate AI summary
        if (reviewsText) {
          try {
            aiSummary = await summarizeReviews(reviewsText);
          } catch (err) {
            console.error("⚠️ AI Summary failed for facility:", facility.provider_name, err);
          }
        }

        // ✅ Return merged final object
        return {
          ...facility,
          googleName: googleData.googleName,
          rating: googleData.rating,
          photo: googleData.photos?.[0] || null,
          lat: googleData.lat,
          lng: googleData.lng,
          aiSummary, // 👈 included
        };
      })
    );
    
     // --- 3. CACHE SET FOR TEXT SEARCH (30 DAYS) ---
    if (finalResults.length > 0) {
        await setCache(
            cacheKey, 
            JSON.stringify(finalResults), 
            SEARCH_CACHE_TTL_SECONDS
        );
    }

    res.status(200).json(finalResults);
  } catch (err) {
    console.error("❌ Error in searchFacilitiesWithReviews:", err);
    next(err);
  }
};


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
//     } = req.query as any;

//     const limit = 20;
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
//         Math.cos(fromCoords.lat * Math.PI / 180) *
//           Math.cos(toCoords.lat * Math.PI / 180) *
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

//     // 🔢 LIMIT
//     pipeline.push({ $limit: limit });

//     // 🚀 EXECUTE
//     const facilities = await Facility.aggregate(pipeline);
//     console.log(`✅ Found ${facilities.length} facilities`);

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
      console.log("🚀 Performing FROM-TO search...");

      const fromCoords = await googleService.getCoordinatesByPlaceName(fromLocation);
      const toCoords = await googleService.getCoordinatesByPlaceName(toLocation);

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
      const coords = await googleService.getCoordinatesByPlaceName(locationName);
      finalLat = coords.lat;
      finalLng = coords.lng;
      finalDistanceKm = distanceKm ? parseFloat(distanceKm) : 20;
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

    // 🚀 EXECUTE QUERY (no limit)
    const facilities = await Facility.aggregate(pipeline);
    console.log(`✅ Found ${facilities.length} facilities`);

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
    next(err);
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
