import mongoose, { Document, Schema } from "mongoose";

export interface IBlog extends Document {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  author: string;
  featuredImage?: string;
  status: 'draft' | 'published';
  publishedAt?: Date;
  metaTitle?: string;
  metaDescription?: string;
  tags: string[];
  readTime: number;
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

const blogSchema = new Schema<IBlog>(
  {
    title: { 
      type: String, 
      required: true, 
      trim: true 
    },
    slug: { 
      type: String, 
      required: true, 
      unique: true, 
      lowercase: true 
    },
    excerpt: { 
      type: String, 
      required: true, 
      maxlength: 300 
    },
    content: { 
      type: String, 
      required: true 
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
    metaTitle: { 
      type: String 
    },
    metaDescription: { 
      type: String 
    },
    tags: [{ 
      type: String 
    }],
    readTime: { 
      type: Number, 
      default: 5 
    },
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
blogSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

// Index for better query performance
blogSchema.index({ status: 1, publishedAt: -1 });
blogSchema.index({ slug: 1 });

export const Blog = mongoose.model<IBlog>("Blog", blogSchema);