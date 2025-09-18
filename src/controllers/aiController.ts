import { Request, Response, NextFunction } from "express";
import { summarizeReviews } from "../services/aiService";

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
