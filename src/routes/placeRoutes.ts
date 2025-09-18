import { Router, Request, Response } from "express";
import { findPlaceIdByText, getPlaceDetails } from "../services/googleService";

const router = Router();

// POST /place
router.post("/", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Place name is required" });

  const placeId = await findPlaceIdByText(name);
  if (!placeId) return res.status(404).json({ error: "Place not found" });

  const details = await getPlaceDetails(placeId);
  if (!details) return res.status(500).json({ error: "Failed to fetch details" });

  res.json(details);
});

export default router;
