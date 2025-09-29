import { Request, Response, NextFunction } from "express";
// import Facility, { IFacility } from "../models/facilityModel";
import * as cmsService from "../services/cmsService";
import * as googleService from "../services/googleService";
import axios from "axios";
import { PlaceDetails,
  findPlaceIdByText,  
  getPlaceDetails } from "../services/googleService";
import { summarizeReviews, SummarizeResult } from "../services/aiService";
import Facility from "../models/NursingFacility"; 



// Get your API key from environment variables


const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";


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
                    photos: photoUrls, // Return array of photo URLs
                    reviews: reviews, 
                  };
            }
        }
    } catch (err) {
        console.error(`Google fetch failed for ${facility.provider_name}:`, err);
    }

    return { googleName: null, rating: null, lat: null, lng: null, photos: [], reviews: [] };
};

// 💡 NEW API: Get Facility Details
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
        
        // 1. Trim and escape the name for safe RegExp usage
        const nameToSearch = name.trim();
        
        // FIX: Change to a "contains" search (no ^ and $ anchors) for better resilience
        const facility = await Facility.findOne({ 
            provider_name: new RegExp(nameToSearch, 'i') 
        }).lean(); 

        if (!facility) {
            console.log(`[DETAIL DEBUG] FAILED to find facility using name: ${nameToSearch}`);
            return res.status(404).json({ message: "Facility not found." });
        }
        
        // 2. Fetch Google details (uses cache or API call)
        const googleData = await fetchAndCacheGoogleData(facility);
        
        // 3. AI Summary Logic (FIXED)
        
        // Initialize AI Summary object with safe defaults
        let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] }; 

         // Extract reviews text from the fetched googleData, not the undefined 'details'
        const reviewsText = googleData.reviews ? googleData.reviews.map((r: any) => r.text).join("\n") : "";

        // Conditionally call the expensive AI summary function
        if (reviewsText) {
            // FIX: Assign the result of the async call back to the 'aiSummary' variable
            aiSummary = await summarizeReviews(reviewsText);
        }
        
        // 4. Merge and return the result
        res.json({
            ...facility, 
            googleName: googleData.googleName,
            rating: googleData.rating,
            photos: googleData.photos, // Array of 4 photo URLs
            reviews: googleData.reviews, // Array of Google reviews
            lat: googleData.lat,
            lng: googleData.lng,
            // Include the dynamically generated AI summary
            aiSummary,
        });

    } catch (err) {
        next(err); 
    }
};

// ... keep searchFacilitiesWithReviews function below this ...

export const searchFacilitiesWithReviews = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const { city, state, zip } = req.query as { city?: string; state?: string; zip?: string; };

        const query: any = {};
        if (city) query.city_town = new RegExp(city, "i");
        if (state) query.state = state.toUpperCase();
        if (zip) query.zip_code = zip;

        const facilities = await Facility.find(query).limit(10).lean(); 

        // Execute all 10 cache/API operations in PARALLEL
        const googlePromises = facilities.map(f => fetchAndCacheGoogleData(f));
        const googleResults = await Promise.all(googlePromises);

        // Merge the results (using the FIRST photo for the list view)
        const finalResults = facilities.map((f, index) => {
            const googleData = googleResults[index];
            const aiSummary = { summary: "", pros: [], cons: [] };

            return {
                ...f, 
                googleName: googleData.googleName,
                rating: googleData.rating,
                // Only return the first photo for the list view
                photo: googleData.photos.length > 0 ? googleData.photos[0] : null, 
                lat: googleData.lat,
                lng: googleData.lng,
                aiSummary,
            };
        });

        res.json(finalResults);
    } catch (err) {
        next(err); 
    }
};

export const filterFacilitiesWithReviews = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        // 1. Get all potential query parameters, including the new 'locationName'
        const { 
            city, state, zip, bedsMin, bedsMax, ownership,
            distanceKm, userLat, userLng, locationName 
        } = req.query as { 
            city?: string; state?: string; zip?: string;
            bedsMin?: string; bedsMax?: string; ownership?: string;
            distanceKm?: string; userLat?: string; userLng?: string;
            locationName?: string; // Location name (e.g., "Eiffel Tower")
        };

        const limit = 10;
        
        // Initial coordinate parsing
        let lat = userLat ? parseFloat(userLat) : NaN;
        let lng = userLng ? parseFloat(userLng) : NaN;
        let distance = distanceKm ? parseFloat(distanceKm) : NaN;

        const hasExplicitGeo = !isNaN(lat) && !isNaN(lng) && !isNaN(distance);
        
        // --- 💡 1. Resolve coordinates from locationName using Google Geocoding ---
        // This block executes if no userLat/userLng are provided, but locationName and distance are.
        if (!hasExplicitGeo && locationName && !isNaN(distance)) {
              const trimmedLocationName = locationName.trim();
            if (trimmedLocationName) {
                 try {
                    console.log(`Geocoding location name: ${trimmedLocationName}`);
                    // Use the service to convert the name to coordinates
                    const coords = await googleService.getCoordinatesByPlaceName(trimmedLocationName);
                    
                    // Update lat/lng variables with the geocoded coordinates
                    lat = coords.lat;
                    lng = coords.lng;
                    
                } catch (err) {
                    console.error(`Failed to geocode location name "${trimmedLocationName}":`, err);
                    // If geocoding fails, we proceed without a geo-query
                }
            }
                
           
        }
        
        // Re-check if geo query is now enabled (either explicitly or via locationName)
        const geoQueryEnabled = !isNaN(lat) && !isNaN(lng) && !isNaN(distance);
        
        const userLngNum = lng;
        const userLatNum = lat;
        const distanceKmNum = distance; 
        
        // --- 2. Build Aggregation Pipeline ---
        const pipeline: any[] = [];
        const matchQuery: any = {};
        
        // --- A. $geoNear Stage (MUST BE FIRST IF USED) ---
        if (geoQueryEnabled) {
            // CRITICAL FIX: Attempt to force MongoDB to check its indexes before query
            try {
                // Access the raw MongoDB driver collection object via Mongoose model
                const collection = Facility.collection; 
                await collection.listIndexes().toArray();
                console.log("🛠️ Index list forced before $geoNear query.");
            } catch (err) {
                // Ignore failure if collection doesn't exist yet or other non-critical error
                console.error("Failed to list indexes for force-check:", err);
            }

            const distanceMeters = distanceKmNum * 1000; 

            pipeline.push({
                $geoNear: {
                    // near must be in the order of the 2d index [longitude, latitude]
                    near: [userLngNum, userLatNum], 
                    key: "longitude", // Must match the field name in the 2d index
                    distanceField: "distance_m", 
                    maxDistance: distanceMeters,
                    spherical: true, 
                    query: matchQuery // Apply other filters *before* geoNear executes
                }
            });
        }

        // --- B. Build the $match Query for all other filters ---
        // (Standard filtering logic remains unchanged)
        
        if (city) matchQuery.city_town = new RegExp(city, "i");
        if (state) matchQuery.state = state.toUpperCase();
        if (zip) matchQuery.zip_code = zip;
        
        // Bed Capacity Filter
        const bedsMinNum = bedsMin ? parseInt(bedsMin) : null;
        const bedsMaxNum = bedsMax ? parseInt(bedsMax) : null;
        if (bedsMinNum || bedsMaxNum) {
            matchQuery.number_of_certified_beds = {};
            if (bedsMinNum) matchQuery.number_of_certified_beds.$gte = bedsMinNum;
            if (bedsMaxNum) matchQuery.number_of_certified_beds.$lte = bedsMaxNum;
        }

        // Ownership Filter
        if (ownership) {
            const ownershipArray = ownership.split(',').map(o => o.trim());
            matchQuery.ownership_type = { $in: ownershipArray };
        }
        
        // If geoQuery was NOT enabled, start the pipeline with the main match
        if (!geoQueryEnabled) {
            if (Object.keys(matchQuery).length > 0) {
                 pipeline.push({ $match: matchQuery });
            }
        }
        
        // --- C. Limit Stage ---
        pipeline.push({ $limit: limit });

        // 3. Execute Aggregation
        // Temporary log for debugging the final query
        console.log('Final Aggregation Pipeline:', JSON.stringify(pipeline, null, 2));

        const facilities = await Facility.aggregate(pipeline); 

        // 4. Execute all cache/API operations in PARALLEL
        const googlePromises = facilities.map(f => fetchAndCacheGoogleData(f));
        const googleResults = await Promise.all(googlePromises);

        // 5. Merge the results
        const finalResults = facilities.map((f, index) => {
            const googleData = googleResults[index];
            // Placeholder for future AI summary
            const aiSummary = { summary: "", pros: [], cons: [] }; 

            return {
                ...f, 
                // Add the calculated distance if geoQuery was run
                distance_m: f.distance_m || null, 
                distance_km: f.distance_m ? f.distance_m / 1000 : null,
                
                googleName: googleData.googleName,
                rating: googleData.rating,
                photo: googleData.photos.length > 0 ? googleData.photos[0] : null, 
                lat: googleData.lat,
                lng: googleData.lng,
                aiSummary,
            };
        });

        res.json(finalResults);
    } catch (err) {
        // Pass the error to the Express error handler
        next(err); 
    }
};

// const fetchAndCacheGoogleData = async (facility: any) => {
//     const cache = facility.googleCache;
//     const now = new Date();
//     const CACHE_LIFETIME = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

//     // 💡 CACHE CHECK: If cache is fresh, return it immediately
//     if (cache && cache.lastUpdated && (now.getTime() - cache.lastUpdated.getTime()) < CACHE_LIFETIME) {
//         return {
//             googleName: cache.googleName,
//             rating: cache.rating,
//             lat: cache.lat,
//             lng: cache.lng,
//             photo: cache.photoReference ? googleService.getPhotoUrl(cache.photoReference) : null,
//         };
//     }

//     // Cache is missing or stale, proceed with expensive API calls
//     try {
//         // FIX: Use correct schema field names (provider_name, zip_code, city_town)
//         let placeId =
//             (await googleService.findPlaceIdByText(facility.provider_name)) ||
//             (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.zip_code}`)) ||
//             (await googleService.findPlaceIdByText(`${facility.provider_name} ${facility.city_town}`));

//         if (placeId) {
//             const details = await googleService.getPlaceDetails(placeId);
//             if (details) {
//                 const newCache = {
//                     placeId,
//                     googleName: details.name,
//                     rating: details.rating,
//                     lat: details.lat,
//                     lng: details.lng,
//                     photoReference: details.photos.length ? details.photos[0].photo_reference : null,
//                     lastUpdated: now
//                 };

//                 // 💡 CACHING: Update MongoDB document in the background
//                 Facility.findOneAndUpdate(
//                     { _id: facility._id }, 
//                     { $set: { googleCache: newCache } }
//                 ).exec().catch(err => console.error(`Cache update failed for ${facility._id}:`, err));

//                 return {
//                     googleName: newCache.googleName,
//                     rating: newCache.rating,
//                     lat: newCache.lat,
//                     lng: newCache.lng,
//                     photo: newCache.photoReference ? googleService.getPhotoUrl(newCache.photoReference) : null,
//                 };
//             }
//         }
//     } catch (err) {
//         console.error(`Google fetch failed for ${facility.provider_name}:`, err);
//     }

//     return { googleName: null, rating: null, lat: null, lng: null, photo: null };
// };


// export const searchFacilitiesWithReviews = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ) => {
//     try {
//         const { city, state, zip } = req.query as {
//             city?: string;
//             state?: string;
//             zip?: string;
//         };

//         // FIX: Mongo query must use schema field names (city_town, zip_code)
//         const query: any = {};
//         if (city) query.city_town = new RegExp(city, "i");
//         if (state) query.state = state.toUpperCase();
//         if (zip) query.zip_code = zip;

//         // 💡 OPTIMIZATION 1: Use .lean() for faster object retrieval
//         const facilities = await Facility.find(query).limit(10).lean(); 

//         // 💡 OPTIMIZATION 2: Execute all 10 cache/API operations in PARALLEL using Promise.all
//         const googlePromises = facilities.map(f => fetchAndCacheGoogleData(f));
//         const googleResults = await Promise.all(googlePromises);

//         // Merge the results
//         const finalResults = facilities.map((f, index) => {
//             const googleData = googleResults[index];
//             const aiSummary = { summary: "", pros: [], cons: [] }; // Placeholder for AI

//             return {
//                 ...f, 
//                 googleName: googleData.googleName,
//                 rating: googleData.rating,
//                 photo: googleData.photo,
//                 lat: googleData.lat,
//                 lng: googleData.lng,
//                 aiSummary,
//             };
//         });

//         res.json(finalResults);
//     } catch (err) {
//         next(err); 
//     }
// };

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
