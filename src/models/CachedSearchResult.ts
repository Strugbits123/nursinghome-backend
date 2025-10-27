// models/CachedSearchResult.ts
import mongoose, { Schema, Document } from "mongoose";

export interface ICachedSearchResult extends Document {
  key: string; // cache key (same as Redis key)
  data: any;
  createdAt: Date;
}

const CachedSearchResultSchema = new Schema<ICachedSearchResult>({
  key: { type: String, unique: true, required: true },
  data: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now, expires: "365d" }, // auto-delete after 1 year
});

export default mongoose.model<ICachedSearchResult>(
  "CachedSearchResult",
  CachedSearchResultSchema
);
