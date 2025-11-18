import mongoose, { Document, Schema } from "mongoose";

export interface INews extends Document {
  title: string;
  summary: string;
  content: string;
  category: string;
  author: string;
  featuredImage?: string;
  status: 'draft' | 'published';
  publishedAt?: Date;
  expiryDate?: Date;
  isFeatured: boolean;
  tags: string[];
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

const newsSchema = new Schema<INews>(
  {
    title: { 
      type: String, 
      required: true, 
      trim: true 
    },
    summary: { 
      type: String, 
      required: true, 
      maxlength: 200 
    },
    content: { 
      type: String, 
      required: true 
    },
    category: { 
      type: String, 
      required: true,
      enum: ['announcement', 'regulation', 'partnership', 'event', 'update', 'general']
    },
    author: { 
      type: String, 
      required: true 
    },
    featuredImage: { 
      type: String 
    },
    status: { 
      type: String, 
      enum: ['draft', 'published'], 
      default: 'draft' 
    },
    publishedAt: { 
      type: Date 
    },
    expiryDate: { 
      type: Date 
    },
    isFeatured: { 
      type: Boolean, 
      default: false 
    },
    tags: [{ 
      type: String 
    }],
    views: { 
      type: Number, 
      default: 0 
    }
  },
  { 
    timestamps: true 
  }
);

// Auto-set publishedAt when status changes to published
newsSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

// Index for better query performance
newsSchema.index({ status: 1, publishedAt: -1 });
newsSchema.index({ category: 1, publishedAt: -1 });
newsSchema.index({ isFeatured: 1, publishedAt: -1 });

export const News = mongoose.model<INews>("News", newsSchema);