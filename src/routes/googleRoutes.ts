import { Router } from "express";
import {
  photosByText,
  detailsByPlaceId,
  detailsByText,
} from "../controllers/googleController";

const router = Router();

router.get("/photos", photosByText);        // e.g., ?q=Green%20Valley%20Nursing%20Home%20Los%20Angeles%20CA
router.get("/details", detailsByPlaceId);   // e.g., ?placeId=ChIJ...
router.get("/details-by-text", detailsByText); // e.g., ?q=...

export default router;
