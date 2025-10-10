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

// --- Configuration and Constants ---
const BASE_URL = "https://maps.googleapis.com/maps/api";
const TIMEOUT_MS = 10000; // 10s timeout
const MAX_RETRIES = 3;
const PHOTO_MAX_WIDTH = 600;

// API key check moved up for immediate use/failure
const apiKey = process.env.GOOGLE_API_KEY || "";
if (!apiKey) {
  
  console.warn("GOOGLE_API_KEY is missing. API calls will likely fail.");
}

const PLACE_DETAILS_FIELDS = "name,geometry,photos,rating,reviews";

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
}

export interface PlaceDetails {
  name: string;
  lat: number | null;
  lng: number | null;
  photos: PlacePhoto[];
  reviews: PlaceReview[];
  rating: number | null;
}


function checkApiKey() {
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY in environment variables.");
  }
}

/**
 * Finds a Place ID by text query using the Text Search API.
 * @param query The text to search for.
 * @returns The place_id or null.
 */
export async function findPlaceIdByText(query: string): Promise<string | null> {
  checkApiKey();
  try {
    const response = await googleAxios.get("/place/textsearch/json", {
      params: { query, key: apiKey },
    });

    const data = response.data;
    // Explicitly check for 'OK' status and results length
    if (data.status === "OK" && data.results?.length > 0) {
      return data.results[0].place_id;
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
 * Gets detailed information for a specific place.
 * @param placeId The ID of the place.
 * @returns PlaceDetails object or null.
 */
export async function getPlaceDetails(
  placeId: string
): Promise<PlaceDetails | null> {
  checkApiKey();
  try {
    const response = await googleAxios.get("/place/details/json", {
      params: {
        place_id: placeId,
        fields: PLACE_DETAILS_FIELDS, // Use constant here
        key: apiKey,
      },
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
    return {
      // Use logical OR (||) for cleaner fallbacks instead of nullish coalescing (??)
      // for properties where an empty string is an acceptable fallback for name.
      name: result.name || "",
      lat: result.geometry?.location?.lat ?? null,
      lng: result.geometry?.location?.lng ?? null,
      photos: result.photos || [],
      reviews: result.reviews || [],
      rating: result.rating ?? null,
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
 * Gets coordinates (lat/lng) for a place name using the Geocoding API.
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

  try {
    const response = await googleAxios.get("/geocode/json", {
      params: { address: placeName, key: apiKey },
    });

    const data = response.data;
    if (data.status !== "OK" || !data.results?.length) {
      const status = data.status || "UNKNOWN";
      throw new Error(
        `Geocoding failed for "${placeName}". Status: ${status}`
      );
    }

    const location = data.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  } catch (err: any) {
    if (err.message.includes("GOOGLE_API_KEY") || err.message.includes("required")) {
      throw err;
    }

    console.error("getCoordinatesByPlaceName error:", err.message || err);
    throw new Error("Failed to fetch coordinates from Google.");
  }
};
