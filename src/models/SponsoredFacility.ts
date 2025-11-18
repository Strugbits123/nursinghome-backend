import mongoose, { Document, Schema } from "mongoose";

export interface ISponsoredBy {
  name: string;
  email: string;
  phone: string;
  submittedAt: Date;
}

export interface ISponsoredFacility extends Document {
  facility: mongoose.Types.ObjectId;
  title: string;
  description: string;
  image?: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  priority: number;
  clicks: number;
  impressions: number;
  sponsoredBy?: ISponsoredBy; // Add this field
  createdAt: Date;
  updatedAt: Date;
}

const sponsoredBySchema = new Schema<ISponsoredBy>({
  name: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true 
  },
  phone: { 
    type: String, 
    required: true 
  },
  submittedAt: { 
    type: Date, 
    default: Date.now 
  }
});

const sponsoredFacilitySchema = new Schema<ISponsoredFacility>(
  {
    facility: { 
      type: Schema.Types.ObjectId, 
      ref: 'NursingFacility', 
      required: true 
    },
    title: { 
      type: String, 
      required: true 
    },
    description: { 
      type: String, 
      required: true 
    },
    image: { 
      type: String 
    },
    startDate: { 
      type: Date, 
      required: true 
    },
    endDate: { 
      type: Date, 
      required: true 
    },
    isActive: { 
      type: Boolean, 
      default: true 
    },
    priority: { 
      type: Number, 
      default: 1,
      min: 1,
      max: 10 
    },
    clicks: { 
      type: Number, 
      default: 0 
    },
    impressions: { 
      type: Number, 
      default: 0 
    },
    sponsoredBy: { // Add this field to the schema
      type: sponsoredBySchema,
      default: null
    }
  },
  { 
    timestamps: true 
  }
);

// Index for active sponsored facilities
sponsoredFacilitySchema.index({ isActive: 1, endDate: 1 });
sponsoredFacilitySchema.index({ facility: 1 });

// Virtual for checking if sponsorship is currently active
sponsoredFacilitySchema.virtual('isCurrentlyActive').get(function() {
  const now = new Date();
  return this.isActive && this.startDate <= now && this.endDate >= now;
});

export const SponsoredFacility = mongoose.model<ISponsoredFacility>("SponsoredFacility", sponsoredFacilitySchema);