import mongoose, { Document, Schema } from "mongoose";

export interface IImageCache extends Document {
  photoReference: string;
  filename: string;
  filePath: string;
  url: string;
  width: number;
  fileSize: number;
  mimeType: string;
  facilityId?: string;
  downloadedAt: Date;
  expiresAt: Date;
  accessCount: number;
  lastAccessed: Date;
  hash: string;
  googlePlaceId?: string;
}

const ImageCacheSchema = new Schema(
  {
    photoReference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    filename: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    width: {
      type: Number,
      required: true,
      default: 600,
    },
    fileSize: {
      type: Number,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
      default: "image/jpeg",
    },
    facilityId: {
      type: String,
      index: true,
    },
    googlePlaceId: {
      type: String,
      index: true,
    },
    downloadedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    accessCount: {
      type: Number,
      default: 0,
    },
    lastAccessed: {
      type: Date,
      default: Date.now,
    },
    hash: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
ImageCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ImageCacheSchema.index({ facilityId: 1, photoReference: 1 });
ImageCacheSchema.index({ hash: 1 });
ImageCacheSchema.index({ lastAccessed: -1 });

export default mongoose.model<IImageCache>("ImageCache", ImageCacheSchema);