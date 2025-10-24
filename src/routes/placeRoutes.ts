import { Router, Request, Response } from "express";
import { 
  findPlaceIdByText, 
  getPlaceDetails,
  batchProcessFacilities,
  getApiUsageStats,
  resetApiUsageStats 
} from "../services/googleService";

const router = Router();

// POST /place - Single place lookup (optimized with caching)
router.post("/", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Place name is required" });

  const placeId = await findPlaceIdByText(name);
  if (!placeId) return res.status(404).json({ error: "Place not found" });

  const details = await getPlaceDetails(placeId);
  if (!details) return res.status(500).json({ error: "Failed to fetch details" });

  res.json(details);
});

// POST /place/batch - Batch process multiple facilities
router.post("/batch", async (req: Request, res: Response) => {
  const { facilities } = req.body;
  if (!facilities || !Array.isArray(facilities)) {
    return res.status(400).json({ error: "Facilities array is required" });
  }

  try {
    const results = await batchProcessFacilities(facilities);
    res.json({
      message: `Processed ${facilities.length} facilities`,
      results,
      successCount: results.filter(r => r.placeId).length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Batch processing failed" });
  }
});

// GET /place/stats - API usage statistics
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const stats = getApiUsageStats();
    
    // Calculate estimated costs
    const estimatedCosts = {
      textSearchRequests: (stats.requestsByType['place_id'] || 0) * 0.017,
      placeDetailsRequests: (stats.requestsByType['place_details'] || 0) * 0.017,
      geocodingRequests: (stats.requestsByType['coordinates'] || 0) * 0.005,
    };

    const totalEstimatedCost = Object.values(estimatedCosts).reduce((sum, cost) => sum + cost, 0);

    res.json({
      ...stats,
      estimatedCosts,
      totalEstimatedCost: totalEstimatedCost.toFixed(4),
      cacheHitRate: stats.totalRequests > 0 ? 
        (stats.cacheHits / stats.totalRequests * 100).toFixed(2) + '%' : '0%',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to get stats" });
  }
});

// POST /place/reset-stats - Reset API usage statistics
router.post("/reset-stats", async (req: Request, res: Response) => {
  try {
    resetApiUsageStats();
    res.json({ message: "API usage stats reset successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to reset stats" });
  }
});

export default router;
