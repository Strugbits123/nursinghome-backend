import express from 'express';
import { News } from '../models/News';
import { protect } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminMiddleware';

const router = express.Router();

// GET /api/news - Get all published news (public)
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const category = req.query.category as string;

    const filter: any = { status: 'published' };
    if (category) {
      filter.category = category;
    }

    const news = await News.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-content'); // Don't send full content in list

    const total = await News.countDocuments(filter);

    res.json({
      news,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalNews: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/news/featured - Get featured news (public)
router.get('/featured', async (req, res) => {
  try {
    const featuredNews = await News.find({ 
      status: 'published', 
      isFeatured: true 
    })
    .sort({ publishedAt: -1 })
    .limit(5)
    .select('-content');

    res.json(featuredNews);
  } catch (error) {
    console.error('Get featured news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/news/:id - Get single news by ID (public)
router.get('/:id', async (req, res) => {
  try {
    const news = await News.findOne({ 
      _id: req.params.id, 
      status: 'published' 
    });

    if (!news) {
      return res.status(404).json({ message: 'News not found' });
    }

    // Increment views
    news.views += 1;
    await news.save();

    res.json(news);
  } catch (error) {
    console.error('Get news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/news/admin/all - Get all news (admin only)
router.get('/admin/all', protect, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status as string;
    const category = req.query.category as string;

    const filter: any = {};
    if (status && ['draft', 'published'].includes(status)) {
      filter.status = status;
    }
    if (category) {
      filter.category = category;
    }

    const news = await News.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await News.countDocuments(filter);

    res.json({
      news,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalNews: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get admin news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/news - Create new news (admin only)
router.post('/', protect, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      summary,
      content,
      category,
      author,
      featuredImage,
      status,
      expiryDate,
      isFeatured,
      tags
    } = req.body;

    const news = new News({
      title,
      summary,
      content,
      category,
      author,
      featuredImage,
      status: status || 'draft',
      expiryDate,
      isFeatured: isFeatured || false,
      tags: tags || []
    });

    await news.save();
    res.status(201).json(news);
  } catch (error) {
    console.error('Create news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/news/:id - Update news (admin only)
router.put('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const news = await News.findById(req.params.id);
    
    if (!news) {
      return res.status(404).json({ message: 'News not found' });
    }

    const updatedNews = await News.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(updatedNews);
  } catch (error) {
    console.error('Update news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/news/:id - Delete news (admin only)
router.delete('/:id', protect, requireAdmin, async (req, res) => {
  try {
    const news = await News.findById(req.params.id);
    
    if (!news) {
      return res.status(404).json({ message: 'News not found' });
    }

    await News.findByIdAndDelete(req.params.id);
    res.json({ message: 'News deleted successfully' });
  } catch (error) {
    console.error('Delete news error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;