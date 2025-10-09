// src/services/googleService.ts
import axios from "axios";

const apiKey = process.env.GOOGLE_API_KEY || "";
const API_KEY = process.env.GOOGLE_API_KEY; 
const BASE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// 👇 Define types for strong typing
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


// 🔹 Get placeId from name (Text Search API)
export async function findPlaceIdByText(query: string): Promise<string | null> {
  try {
    const url = "https://maps.googleapis.com/maps/api/place/textsearch/json";
    const response = await axios.get(url, {
      params: {
        query,
        key: apiKey,
      },
    });

    if (response.data.status === "OK" && response.data.results.length > 0) {
      return response.data.results[0].place_id;
    }
    return null;
  } catch (err) {
    console.error("findPlaceIdByText error:", err);
    return null;
  }
}

// 🔹 Get place details
export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  try {
    const url = "https://maps.googleapis.com/maps/api/place/details/json";
    const response = await axios.get(url, {
      params: {
        place_id: placeId,
        fields: "name,geometry,photos,rating,reviews",
        key: apiKey,
      },
    });

    const result = response.data.result;
    if (!result) return null;

    return {
      name: result.name,
      lat: result.geometry?.location?.lat ?? null,
      lng: result.geometry?.location?.lng ?? null,
      photos: result.photos || [],
      reviews: result.reviews || [],
      rating: result.rating ?? null,
    };
  } catch (err) {
    console.error("getPlaceDetails error:", err);
    return null;
  }
}

// 🔹 Generate Google photo URL
export function getPhotoUrl(photoRef: string) {
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoRef}&key=${apiKey}`;
}


export const getCoordinatesByPlaceName = async (placeName: string): Promise<{ lat: number; lng: number }> => {

  if (!apiKey) throw new Error("Missing GOOGLE_MAPS_API_KEY in environment variables.");
  if (!placeName || placeName.trim() === "") throw new Error("Place name is required.");

  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: placeName,
        key: apiKey,
      },
    });

    const data = response.data;

    if (data.status !== "OK" || !data.results.length) {
      throw new Error(`Geocoding failed for "${placeName}". Status: ${data.status}`);
    }

    const location = data.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  } catch (error: any) {
    console.error("Google Geocoding API error:", error);
    throw new Error("Failed to fetch coordinates from Google.");
  }
};


// export async function findPlaceIdByText(query: string): Promise<string | null> {
//   const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(
//     query
//   )}&inputtype=textquery&fields=place_id&key=${apiKey}`;

//   try {
//     const res = await axios.get(url);
//     console.log("Google TextSearch response:", res.data);

//     if (res.data.status === "OK" && res.data.candidates?.length) {
//       return res.data.candidates[0].place_id;
//     }
//     return null;
//   } catch (error: any) {
//     console.error("Error calling Google API:", error.response?.data || error.message);
//     return null;
//   }
// }


// // 📍 Get details by Place ID
// export async function getPlaceDetails(placeId: string): Promise<PlaceDetails> {
//   const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry,reviews,photos&key=${apiKey}`;
//   const res = await axios.get(url);

//   const result = res.data.result || {};
//   console.log("getPlaceDetails:", result);

//   return {
//     name: result.name ?? null,
//     lat: result.geometry?.location?.lat ?? null,
//     lng: result.geometry?.location?.lng ?? null,
//     reviews: result.reviews || [],
//     photos: result.photos || [],
//   };
// }

// // 🖼 Convert photo_reference → usable URL
// export function getPhotoUrl(photoReference: string): string {
//   return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoReference}&key=${apiKey}`;
// }
