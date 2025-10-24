import {
  searchFacilities,
  getFacilityById,
  syncFacilities,
  searchFacilitiesWithReviews,
  getFacilityDetails,
  filterFacilitiesWithReviews
} from "../controllers/facilityController";
import { protect } from "../middleware/authMiddleware";
import { Router, Request, Response, NextFunction } from "express";

const router = Router();
// Middleware to disable browser caching
const noCacheMiddleware = (req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
};

// Apply middleware to this route
router.get("/with-reviews", noCacheMiddleware, searchFacilitiesWithReviews);
router.get('/details', getFacilityDetails); 
router.get("/filter-with-reviews", filterFacilitiesWithReviews);

// Public route
router.get("/search", searchFacilities);
router.get("/:id", getFacilityById);
router.post("/sync", protect, syncFacilities);

export default router;