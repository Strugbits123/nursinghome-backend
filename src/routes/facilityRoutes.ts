import { Router } from "express";
import {
  searchFacilities,
  getFacilityById,
  syncFacilities,
  searchFacilitiesWithReviews
} from "../controllers/facilityController";
import { protect } from "../middlewares/authMiddleware";

const router = Router();
router.get("/with-reviews", searchFacilitiesWithReviews);

// Public route
router.get("/search", searchFacilities);
router.get("/:id", getFacilityById);
router.post("/sync", protect, syncFacilities);

export default router;