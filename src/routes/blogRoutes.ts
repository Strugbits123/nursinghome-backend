import express from 'express';
import { Blog } from '../models/Blog';
import { protect } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminMiddleware';

const router = express.Router();

// Type guard to check if error is a MongoDB duplicate key error
function isMongoError(error: unknown): error is { code: number; keyPattern: Record<string, unknown>; keyValue: Record<string, unknown> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as any).code === 11000
  );
}

// Type guard to check if error has a message
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as any).message === 'string'
  );
}

// GET /api/blogs - Get all published blogs (public)
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const blogs = await Blog.find({ status: 'published' })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-content');

    const total = await Blog.countDocuments({ status: 'published' });

    res.json({
      blogs,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalBlogs: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error: unknown) {
    console.error('Get blogs error:', error);
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

// GET /api/blogs/:slug - Get single blog by slug (public)
router.get('/:slug', async (req, res) => {
  try {
    const blog = await Blog.findOne({ 
      slug: req.params.slug, 
      status: 'published' 
    });

    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    // Increment views
    blog.views += 1;
    await blog.save();

    res.json(blog);
  } catch (error: unknown) {
    console.error('Get blog error:', error);
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

// GET /api/blogs/admin/all - Get all blogs (admin only)
router.get('/admin/all', protect, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status as string;

    const filter: any = {};
    if (status && ['draft', 'published'].includes(status)) {
      filter.status = status;
    }

    const blogs = await Blog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Blog.countDocuments(filter);

    res.json({
      blogs,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalBlogs: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error: unknown) {
    console.error('Get admin blogs error:', error);
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

// POST /api/blogs - Create new blog (admin only)
router.post('/', protect, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      excerpt,
      content,
      author,
      featuredImage,
      status,
      metaTitle,
      metaDescription,
      tags,
      readTime
    } = req.body;

    // Generate slug from title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    const blog = new Blog({
      title,
      slug,
      excerpt,
      content,
      author,
      featuredImage,
      status: status || 'draft',
      metaTitle: metaTitle || title,
      metaDescription: metaDescription || excerpt,
      tags: tags || [],
      readTime: readTime || 5
    });

    await blog.save();
    res.status(201).json(blog);
  } catch (error: unknown) {
    console.error('Create blog error:', error);
    
    if (isMongoError(error)) {
      return res.status(400).json({ message: 'Blog with this slug already exists' });
    }
    
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

// PUT /api/blogs/:id - Update blog (admin only)
router.put('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    // If title changed, update slug
    if (req.body.title && req.body.title !== blog.title) {
      req.body.slug = req.body.title
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    }

    const updatedBlog = await Blog.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(updatedBlog);
  } catch (error: unknown) {
    console.error('Update blog error:', error);
    
    if (isMongoError(error)) {
      return res.status(400).json({ message: 'Blog with this slug already exists' });
    }
    
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

// DELETE /api/blogs/:id - Delete blog (admin only)
router.delete('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    await Blog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Blog deleted successfully' });
  } catch (error: unknown) {
    console.error('Delete blog error:', error);
    const errorMessage = isErrorWithMessage(error) ? error.message : 'Server error';
    res.status(500).json({ message: errorMessage });
  }
});

export default router;