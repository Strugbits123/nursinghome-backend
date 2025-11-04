import {
  searchFacilities,
  getFacilityById,
  syncFacilities,
  searchFacilitiesWithReviews,
  getFacilityDetails,
  filterFacilitiesWithReviews,
  getTop10Facilities
} from "../controllers/facilityController";
import { protect } from "../middleware/authMiddleware";
import { Router, Request, Response, NextFunction } from "express";

const router = Router();

router.get("/with-reviews", searchFacilitiesWithReviews);
router.get('/details', getFacilityDetails); 
router.get("/filter-with-reviews", filterFacilitiesWithReviews);
router.get("/top-10", getTop10Facilities);

// Public route
router.get("/search", searchFacilities);
router.get("/:id", getFacilityById);
router.post("/sync", protect, syncFacilities);

export default router;