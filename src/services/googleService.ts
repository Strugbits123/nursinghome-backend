// import axios from "axios";
// import axiosRetry from "axios-retry";

// const apiKey = process.env.GOOGLE_API_KEY || "";

// // ---------------------------
// // Axios instance with retry
// // ---------------------------
// const googleAxios = axios.create({
//   baseURL: "https://maps.googleapis.com/maps/api",
//   timeout: 10000, // 10s timeout
// });

// axiosRetry(googleAxios, {
//   retries: 3,
//   retryDelay: axiosRetry.exponentialDelay,
//   retryCondition: (error) =>
//     axiosRetry.isNetworkError(error) || error.code === "ECONNRESET",
// });

// // ---------------------------
// // Types
// // ---------------------------
// export interface PlacePhoto {
//   photo_reference: string;
//   height: number;
//   width: number;
// }

// export interface PlaceReview {
//   author_name: string;
//   text: string;
//   rating: number;
//   relative_time_description: string;
// }

// export interface PlaceDetails {
//   name: string;
//   lat: number | null;
//   lng: number | null;
//   photos: PlacePhoto[];
//   reviews: PlaceReview[];
//   rating: number | null;
// }

// // ---------------------------
// // Google API functions
// // ---------------------------
// export async function findPlaceIdByText(query: string): Promise<string | null> {
//   try {
//     const response = await googleAxios.get("/place/textsearch/json", {
//       params: { query, key: apiKey },
//     });
//     const results = response.data.results;
//     if (response.data.status === "OK" && results?.length > 0) {
//       return results[0].place_id;
//     }
//     return null;
//   } catch (err: any) {
//     console.error("findPlaceIdByText error:", err.message || err);
//     return null;
//   }
// }

// export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
//   try {
//     const response = await googleAxios.get("/place/details/json", {
//       params: {
//         place_id: placeId,
//         fields: "name,geometry,photos,rating,reviews",
//         key: apiKey,
//       },
//     });

//     const result = response.data.result;
//     if (!result) return null;

//     return {
//       name: result.name ?? "",
//       lat: result.geometry?.location?.lat ?? null,
//       lng: result.geometry?.location?.lng ?? null,
//       photos: result.photos ?? [],
//       reviews: result.reviews ?? [],
//       rating: result.rating ?? null,
//     };
//   } catch (err: any) {
//     console.error("getPlaceDetails error:", err.message || err);
//     return null;
//   }
// }

// export function getPhotoUrl(photoRef?: string): string | null {
//   if (!photoRef) return null;
//   return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoRef}&key=${apiKey}`;
// }

// export const getCoordinatesByPlaceName = async (
//   placeName: string
// ): Promise<{ lat: number; lng: number }> => {
//   if (!apiKey) throw new Error("Missing GOOGLE_MAPS_API_KEY in environment variables.");
//   if (!placeName?.trim()) throw new Error("Place name is required.");

//   try {
//     const response = await googleAxios.get("/geocode/json", {
//       params: { address: placeName, key: apiKey },
//     });

//     const data = response.data;
//     if (data.status !== "OK" || !data.results?.length) {
//       throw new Error(`Geocoding failed for "${placeName}". Status: ${data.status}`);
//     }

//     const location = data.results[0].geometry.location;
//     return { lat: location.lat, lng: location.lng };
//   } catch (err: any) {
//     console.error("getCoordinatesByPlaceName error:", err.message || err);
//     throw new Error("Failed to fetch coordinates from Google.");
//   }
// };


import axios, { AxiosError } from "axios";
import axiosRetry from "axios-retry";
import { getCache, setCache } from "../config/redisClient";

// --- Configuration and Constants ---
const BASE_URL = "https://maps.googleapis.com/maps/api";
const TIMEOUT_MS = 10000; // 10s timeout
const MAX_RETRIES = 3;
const PHOTO_MAX_WIDTH = 600;

// Cache TTL constants (in seconds)
const CACHE_TTL = {
  PLACE_ID: 30 * 24 * 60 * 60, // 30 days
  PLACE_CORE: 365 * 24 * 60 * 60, // 1 year for stable core details
  PLACE_REVIEWS: 7 * 24 * 60 * 60, // refresh reviews weekly
  COORDINATES: 365 * 24 * 60 * 60, // 1 year (coordinates rarely change)
};

// Rate limiting
const RATE_LIMIT = {
  REQUESTS_PER_SECOND: 10, // Conservative limit
  BATCH_SIZE: 5, // Process facilities in batches
};

// API key check moved up for immediate use/failure
const apiKey = process.env.GOOGLE_API_KEY || "";
if (!apiKey) {
  console.warn("GOOGLE_API_KEY is missing. API calls will likely fail.");
}

const PLACE_DETAILS_FIELDS = "name,geometry,photos,rating,reviews";

// Rate limiting state
let requestQueue: Array<() => Promise<any>> = [];
let isProcessingQueue = false;

const googleAxios = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
});

axiosRetry(googleAxios, {
  retries: MAX_RETRIES,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkError(error) ||
    (error as AxiosError).code === "ECONNRESET",
});


export interface PlacePhoto {
  photo_reference: string;
  height: number;
  width: number;
}

export interface PlaceReview {
  author_name: string;
  text: string;
  rating: number;
  relative_time_description: string;
  profile_photo_url?: string;
  author_url?: string;
}

export interface PlaceDetails {
  name: string;
  lat: number | null;
  lng: number | null;
  photos: PlacePhoto[];
  reviews: PlaceReview[];
  rating: number | null;
}

interface PlaceCoreDetails {
  name: string;
  lat: number | null;
  lng: number | null;
  photos: PlacePhoto[]; // we will store full objects but consume top 4
  rating: number | null;
}


function checkApiKey() {
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in environment variables.");
  }
}

// Rate limiting helper
async function rateLimitedRequest<T>(requestFn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestQueue.push(async () => {
      try {
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });

    if (!isProcessingQueue) {
      processQueue();
    }
  });
}

async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const batch = requestQueue.splice(0, RATE_LIMIT.BATCH_SIZE);
    await Promise.all(batch.map(fn => fn()));
    
    // Wait 1 second between batches to respect rate limits
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  isProcessingQueue = false;
}

// Cache helpers
function getCacheKey(type: string, identifier: string): string {
  return `google:${type}:${identifier}`;
}

async function getCachedData<T>(key: string): Promise<T | null> {
  try {
    const cached = await getCache(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn(`Cache read error for key ${key}:`, error);
    return null;
  }
}

async function setCachedData<T>(key: string, data: T, ttl: number): Promise<void> {
  try {
    await setCache(key, JSON.stringify(data), ttl);
  } catch (error) {
    console.warn(`Cache write error for key ${key}:`, error);
  }
}

/**
 * Finds a Place ID by text query using the Text Search API with caching.
 * @param query The text to search for.
 * @returns The place_id or null.
 */
export async function findPlaceIdByText(query: string): Promise<string | null> {
  checkApiKey();
  
  // Normalize query for cache key
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = getCacheKey("place_id", normalizedQuery);
  
  // Check cache first
  const cached = await getCachedDataWithTracking<string>(cacheKey, "place_id");
  if (cached) {
    return cached;
  }

  try {
    const response = await rateLimitedRequest(async () => {
      return await googleAxios.get("/place/textsearch/json", {
        params: { query, key: apiKey },
      });
    });

    const data = response.data;
    // Explicitly check for 'OK' status and results length
    if (data.status === "OK" && data.results?.length > 0) {
      const placeId = data.results[0].place_id;
      
      // Cache the result
      await setCachedDataWithTracking(cacheKey, placeId, CACHE_TTL.PLACE_ID, "place_id");
      
      return placeId;
    }
    if (data.status !== "OK") {
      console.warn(
        `findPlaceIdByText API status not OK: ${data.status}. Query: ${query}`
      );
    }
    return null;
  } catch (err: any) {
    console.error("findPlaceIdByText error:", err.message || err);
    return null;
  }
}

/**
 * Gets detailed information for a specific place with caching.
 * @param placeId The ID of the place.
 * @returns PlaceDetails object or null.
 */
export async function getPlaceDetails(
  placeId: string
): Promise<PlaceDetails | null> {
  checkApiKey();
  
  const coreKey = getCacheKey("place_core", placeId);
  const reviewsKey = getCacheKey("place_reviews", placeId);
  
  // Try to read both caches
  const [cachedCore, cachedReviews] = await Promise.all([
    getCachedData<PlaceCoreDetails>(coreKey),
    getCachedData<PlaceReview[]>(reviewsKey),
  ]);
  
  if (cachedCore && cachedReviews) {
    // Return assembled result, limiting to 4 photos
    return {
      name: cachedCore.name,
      lat: cachedCore.lat,
      lng: cachedCore.lng,
      photos: (cachedCore.photos || []).slice(0, 4),
      reviews: cachedReviews,
      rating: cachedCore.rating ?? null,
    };
  }

  try {
    const response = await rateLimitedRequest(async () => {
      return await googleAxios.get("/place/details/json", {
        params: {
          place_id: placeId,
          fields: PLACE_DETAILS_FIELDS,
          key: apiKey,
        },
      });
    });

    const data = response.data;
    if (data.status !== "OK" || !data.result) {
      if (data.status !== "OK") {
        console.warn(
          `getPlaceDetails API status not OK: ${data.status}. Place ID: ${placeId}`
        );
      }
      return null;
    }

    const result = data.result;
    const core: PlaceCoreDetails = {
      name: result.name || "",
      lat: result.geometry?.location?.lat ?? null,
      lng: result.geometry?.location?.lng ?? null,
      photos: result.photos || [],
      rating: result.rating ?? null,
    };
    const reviews: PlaceReview[] = result.reviews || [];

    // Update caches with separate TTLs. Only refresh core if missing
    const writes: Promise<void>[] = [];
    if (!cachedCore) {
      writes.push(setCachedData(coreKey, core, CACHE_TTL.PLACE_CORE));
    }
    // Always refresh reviews when we called Google
    writes.push(setCachedData(reviewsKey, reviews, CACHE_TTL.PLACE_REVIEWS));
    await Promise.all(writes);

    return {
      name: core.name,
      lat: core.lat,
      lng: core.lng,
      photos: (core.photos || []).slice(0, 4),
      reviews,
      rating: core.rating ?? null,
    };
  } catch (err: any) {
    console.error("getPlaceDetails error:", err.message || err);
    return null;
  }
}

/**
 * Constructs the URL for a place photo.
 * @param photoRef The photo reference string.
 * @returns The full photo URL or null.
 */
export function getPhotoUrl(photoRef?: string): string | null {
  if (!photoRef) return null;
  return `${BASE_URL}/place/photo?maxwidth=${PHOTO_MAX_WIDTH}&photoreference=${photoRef}&key=${apiKey}`;
}

/**
 * Gets coordinates (lat/lng) for a place name using the Geocoding API with caching.
 * @param placeName The name or address to geocode.
 * @returns A promise resolving to { lat: number, lng: number }.
 */
export const getCoordinatesByPlaceName = async (
  placeName: string
): Promise<{ lat: number; lng: number }> => {
  checkApiKey(); 
  if (!placeName?.trim()) {
    throw new Error("Place name is required.");
  }

  const normalizedPlaceName = placeName.trim().toLowerCase();
  const cacheKey = getCacheKey("coordinates", normalizedPlaceName);
  
  const cached = await getCachedData<{ lat: number; lng: number }>(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await rateLimitedRequest(async () => {
      return await googleAxios.get("/geocode/json", {
        params: { address: placeName, key: apiKey },
      });
    });

    const data = response.data;
    if (data.status !== "OK" || !data.results?.length) {
      const status = data.status || "UNKNOWN";
      throw new Error(
        `Geocoding failed for "${placeName}". Status: ${status}`
      );
    }

    const location = data.results[0].geometry.location;
    const coordinates = { lat: location.lat, lng: location.lng };
    
    await setCachedData(cacheKey, coordinates, CACHE_TTL.COORDINATES);
    
    return coordinates;
  } catch (err: any) {
    if (err.message.includes("GOOGLE_API_KEY") || err.message.includes("required")) {
      throw err;
    }

    console.error("getCoordinatesByPlaceName error:", err.message || err);
    throw new Error("Failed to fetch coordinates from Google.");
  }
};

export interface FacilityGoogleData {
  facilityId: string;
  providerName: string;
  zipCode?: string;
  cityTown?: string;
}

export interface BatchGoogleResult {
  facilityId: string;
  placeId: string | null;
  placeDetails: PlaceDetails | null;
  error?: string;
}

/**
 * Processes multiple facilities in batches to reduce API calls and costs.
 * @param facilities Array of facility data to process
 * @returns Array of results with place IDs and details
 */
export async function batchProcessFacilities(
  facilities: FacilityGoogleData[]
): Promise<BatchGoogleResult[]> {
  checkApiKey();
  
  const results: BatchGoogleResult[] = [];
  const batchSize = RATE_LIMIT.BATCH_SIZE;
  
  console.log(`🔄 Processing ${facilities.length} facilities in batches of ${batchSize}`);
  
  for (let i = 0; i < facilities.length; i += batchSize) {
    const batch = facilities.slice(i, i + batchSize);
    console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(facilities.length / batchSize)}`);
    
    const batchResults = await Promise.allSettled(
      batch.map(async (facility) => {
        try {
          const searchQueries = [
            facility.providerName,
            `${facility.providerName} ${facility.zipCode}`,
            `${facility.providerName} ${facility.cityTown}`,
          ].filter(Boolean);
          
          let placeId: string | null = null;
          
          for (const query of searchQueries) {
            placeId = await findPlaceIdByText(query);
            if (placeId) break;
          }
          
          if (!placeId) {
            return {
              facilityId: facility.facilityId,
              placeId: null,
              placeDetails: null,
              error: "No place found"
            };
          }
          
          const placeDetails = await getPlaceDetails(placeId);
          
          return {
            facilityId: facility.facilityId,
            placeId,
            placeDetails,
          };
        } catch (error: any) {
          return {
            facilityId: facility.facilityId,
            placeId: null,
            placeDetails: null,
            error: error.message || "Unknown error"
          };
        }
      })
    );
    
    batchResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          facilityId: batch[index].facilityId,
          placeId: null,
          placeDetails: null,
          error: result.reason?.message || "Promise rejected"
        });
      }
    });
    
    if (i + batchSize < facilities.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  const successCount = results.filter(r => r.placeId).length;
  console.log(`✅ Batch processing complete: ${successCount}/${facilities.length} facilities processed successfully`);
  
  return results;
}

interface ApiUsageStats {
  totalRequests: number;
  requestsByType: Record<string, number>;
  cacheHits: number;
  cacheMisses: number;
  lastReset: Date;
}

let apiUsageStats: ApiUsageStats = {
  totalRequests: 0,
  requestsByType: {},
  cacheHits: 0,
  cacheMisses: 0,
  lastReset: new Date(),
};

export function getApiUsageStats(): ApiUsageStats {
  return { ...apiUsageStats };
}

export function resetApiUsageStats(): void {
  apiUsageStats = {
    totalRequests: 0,
    requestsByType: {},
    cacheHits: 0,
    cacheMisses: 0,
    lastReset: new Date(),
  };
}

function trackApiUsage(type: string, cacheHit: boolean = false): void {
  apiUsageStats.totalRequests++;
  apiUsageStats.requestsByType[type] = (apiUsageStats.requestsByType[type] || 0) + 1;
  
  if (cacheHit) {
    apiUsageStats.cacheHits++;
  } else {
    apiUsageStats.cacheMisses++;
  }
}

async function getCachedDataWithTracking<T>(key: string, type: string): Promise<T | null> {
  try {
    const cached = await getCache(key);
    const cacheHit = !!cached;
    trackApiUsage(type, cacheHit);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    console.warn(`Cache read error for key ${key}:`, error);
    trackApiUsage(type, false);
    return null;
  }
}

async function setCachedDataWithTracking<T>(key: string, data: T, ttl: number, type: string): Promise<void> {
  try {
    await setCache(key, JSON.stringify(data), ttl);
    trackApiUsage(type, false);
  } catch (error) {
    console.warn(`Cache write error for key ${key}:`, error);
  }
}