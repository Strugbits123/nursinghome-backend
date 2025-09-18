import { Request, Response, NextFunction } from "express";
import * as googleService from "../services/googleService";

// Get photos by text query
export const photosByText = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ message: "Missing q query param" });

    const data = await googleService.findPlaceIdByText(q);
    res.json(data);
  } catch (err) {
    next(err);
  }
};

// Get place details by placeId
export const detailsByPlaceId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const placeId = req.query.placeId as string;
    if (!placeId) return res.status(400).json({ message: "Missing placeId" });

    const data = await googleService.getPlaceDetails(placeId);
    res.json(data);
  } catch (err) {
    next(err);
  }
};

// Get place details by text search
export const detailsByText = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ message: "Missing q query param" });

    const placeId = await googleService.findPlaceIdByText(q);
    if (!placeId) return res.status(404).json({ message: "Place not found" });

    const data = await googleService.getPlaceDetails(placeId);
    res.json(data);
  } catch (err) {
    next(err);
  }
};
