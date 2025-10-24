import { Request, Response, NextFunction } from "express";
import { summarizeReviews, getAiUsageStats, resetAiUsageStats } from "../services/aiService";

export const summarize = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.body as { text?: string };

    if (!text) return res.status(400).json({ message: "text is required" });

    const result = await summarizeReviews(text);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

export const getUsageStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = getAiUsageStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
};

export const resetUsageStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    resetAiUsageStats();
    res.json({ message: "AI usage stats reset successfully" });
  } catch (err) {
    next(err);
  }
};
