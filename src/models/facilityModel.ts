import mongoose, { Document, Schema, Model } from "mongoose";


export interface IFacility extends Document {
  cmsId: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  ownership?: string;
  bedCount?: number;
  rating?: number;
  staffing?: Record<string, any>; // flexible JSON
  lastUpdated?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const facilitySchema: Schema<IFacility> = new Schema(
  {
    cmsId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    zip: { type: String },
    phone: { type: String },
    ownership: { type: String },
    bedCount: { type: Number },
    rating: { type: Number },
    staffing: { type: Schema.Types.Mixed }, // flexible JSON
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Facility: Model<IFacility> = mongoose.model<IFacility>("Facility", facilitySchema);
export default Facility;