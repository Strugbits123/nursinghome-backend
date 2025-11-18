import {
  searchFacilities,
  getFacilityById,
  syncFacilities,
  searchFacilitiesWithReviews,
  getFacilityDetails,
  filterFacilitiesWithReviews,
  getTop10Facilities,
  refreshFacilityGoogleData,
  batchRefreshGoogleData,
  testGooglePlacesApi,
  getAllFacilities
} from "../controllers/facilityController";
import { protect } from "../middleware/authMiddleware";
import { Router } from "express";

const router = Router();

router.get("/with-reviews", searchFacilitiesWithReviews);
router.get('/details', getFacilityDetails); 
router.get("/filter-with-reviews", filterFacilitiesWithReviews);
router.get("/top-10", getTop10Facilities);
router.get("/all", getAllFacilities);


router.get('/:facilityId/refresh-google', refreshFacilityGoogleData);
router.get('/refresh-google-batch', batchRefreshGoogleData);
router.get('/test-google-places', testGooglePlacesApi);


// Public route
router.get("/search", searchFacilities);
router.get("/:id", getFacilityById);
router.post("/sync", protect, syncFacilities);

export default router;