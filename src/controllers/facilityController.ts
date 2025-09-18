import { Request, Response, NextFunction } from "express";
import Facility, { IFacility } from "../models/facilityModel";
import * as cmsService from "../services/cmsService";
import * as googleService from "../services/googleService";
import axios from "axios";
import { PlaceDetails,
  findPlaceIdByText,  
  getPlaceDetails } from "../services/googleService";
import { summarizeReviews, SummarizeResult } from "../services/aiService";


const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";


export const searchFacilitiesWithReviews = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { city, state, zip } = req.query as {
      city?: string;
      state?: string;
      zip?: string;
    };

    // Mongo query
    const query: any = {};
    if (city) query.city = new RegExp(city, "i");
    if (state) query.state = state.toUpperCase();
    if (zip) query.zip = zip;

    const facilities = await Facility.find(query).limit(10);

    const results = [];
    for (const f of facilities) {
      let aiSummary: SummarizeResult = { summary: "", pros: [], cons: [] };
      let photo: string | null = null;
      let lat: number | null = null;
      let lng: number | null = null;
      let googleName: string | null = null;
      let rating: number | null = null;

      try {
        // 🔹 Try multiple queries to get placeId
        let placeId =
          (await googleService.findPlaceIdByText(f.name)) ||
          (await googleService.findPlaceIdByText(`${f.name} ${f.zip}`)) ||
          (await googleService.findPlaceIdByText(`${f.name} ${f.city}`));

        console.log("Searching Place:", f.name, "=> placeId:", placeId);

        if (placeId) {
          const details = await googleService.getPlaceDetails(placeId);
          if (details) {
            googleName = details.name;
            rating = details.rating;
            lat = details.lat;
            lng = details.lng;

            // first photo
            if (details.photos.length) {
              photo = googleService.getPhotoUrl(details.photos[0].photo_reference);
            }

            // summarize reviews via AI
            // const reviewsText = details.reviews.map((r) => r.text).join("\n");
            // if (reviewsText) {
            //   aiSummary = await summarizeReviews(reviewsText);
            // }
          }
        }
      } catch (err) {
        console.error(`Google fetch failed for ${f.name}:`, err);
      }

      results.push({
        ...f.toObject(),
        googleName,
        rating,
        photo,
        lat,
        lng,
        aiSummary,
      });
    }

    res.json(results);
  } catch (err) {
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

    const queryText = `${facility.name}`;
    const placeId = await googleService.findPlaceIdByText(queryText);

    // Optional Google enrichment
    let googleData: PlaceDetails | null = null;
    if (placeId) {
      googleData = await googleService.getPlaceDetails(placeId);
    }

    // 👇 Return only name (local DB name or Google name)
    return res.json({
      success: true,
      name: facility.name, // from your DB
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
