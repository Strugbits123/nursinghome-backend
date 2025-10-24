import { Router } from "express";
import { summarize, getUsageStats, resetUsageStats } from "../controllers/aiController";

const router = Router();

router.post("/summarize", summarize);
router.get("/usage-stats", getUsageStats);
router.post("/reset-stats", resetUsageStats);

export default router;
