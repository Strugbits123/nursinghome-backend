import { Router } from "express";
import {
  searchFacilities,
  getFacilityById,
  syncFacilities,
  searchFacilitiesWithReviews,
  getFacilityDetails,
  filterFacilitiesWithReviews
} from "../controllers/facilityController";
import { protect } from "../middleware/authMiddleware";

const router = Router();
router.get("/with-reviews", searchFacilitiesWithReviews);
router.get('/details', getFacilityDetails); 
router.get("/filter-with-reviews", filterFacilitiesWithReviews);

// Public route
router.get("/search", searchFacilities);
router.get("/:id", getFacilityById);
router.post("/sync", protect, syncFacilities);

export default router;