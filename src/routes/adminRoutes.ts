import express, { Request, Response } from 'express';
import { User } from '../models/User';
import { Blog } from '../models/Blog';
import { News } from '../models/News';
import { SponsoredFacility } from '../models/SponsoredFacility';
import  NursingFacility  from '../models/NursingFacility';
import { protect } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminMiddleware';

const router = express.Router();

// GET /api/admin/dashboard - Get admin dashboard stats
router.get('/dashboard', protect, requireAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      totalFacilities,
      totalBlogs,
      totalNews,
      totalSponsored,
      publishedBlogs,
      publishedNews,
      activeSponsored
    ] = await Promise.all([
      User.countDocuments(),
      NursingFacility.countDocuments(),
      Blog.countDocuments(),
      News.countDocuments(),
      SponsoredFacility.countDocuments(),
      Blog.countDocuments({ status: 'published' }),
      News.countDocuments({ status: 'published' }),
      SponsoredFacility.countDocuments({ 
        isActive: true,
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() }
      })
    ]);

    // Recent activities
    const recentBlogs = await Blog.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title status createdAt');

    const recentNews = await News.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title status createdAt');

    res.json({
      stats: {
        totalUsers,
        totalFacilities,
        totalBlogs,
        totalNews,
        totalSponsored,
        publishedBlogs,
        publishedNews,
        activeSponsored
      },
      recentActivities: {
        blogs: recentBlogs,
        news: recentNews
      }
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/admin/users - Get all users (admin only)
router.get('/users', protect, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const users = await User.find()
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments();

    res.json({
      users,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalUsers: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/admin/users/:id/role - Update user role (admin only)
router.put('/users/:id/role', protect, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get all sponsored facilities
router.get('/sponsored-facilities', async (req: Request, res: Response) => {
  try {
    const sponsoredFacilities = await SponsoredFacility.find()
      .populate('facility', 'provider_name city_town state zip_code telephone_number overall_rating')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      sponsoredFacilities
    });
  } catch (error) {
    console.error('Error fetching sponsored facilities:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sponsored facilities'
    });
  }
});

// Create new sponsored facility
router.post('/sponsored-facilities', async (req: Request, res: Response) => {
  try {
    const { title, description, startDate, endDate, priority, isActive, facilityId } = req.body;

    // You'll need to select a facility - this could be from a dropdown in your form
    // For now, using a sample facility ID
    const facility = await NursingFacility.findOne();
    
    if (!facility) {
      return res.status(404).json({
        success: false,
        error: 'No facility found'
      });
    }

    const sponsoredFacility = await SponsoredFacility.create({
      facility: facility._id,
      title,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      priority,
      isActive
    });

    const populatedFacility = await SponsoredFacility.findById(sponsoredFacility._id)
      .populate('facility', 'provider_name city_town state zip_code telephone_number overall_rating');

    res.json({
      success: true,
      sponsoredFacility: populatedFacility
    });
  } catch (error) {
    console.error('Error creating sponsored facility:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create sponsored facility'
    });
  }
});

// Update sponsored facility
router.put('/sponsored-facilities/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, startDate, endDate, priority, isActive } = req.body;

    const sponsoredFacility = await SponsoredFacility.findByIdAndUpdate(
      id,
      {
        title,
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        priority,
        isActive
      },
      { new: true }
    ).populate('facility', 'provider_name city_town state zip_code telephone_number overall_rating');

    if (!sponsoredFacility) {
      return res.status(404).json({
        success: false,
        error: 'Sponsored facility not found'
      });
    }

    res.json({
      success: true,
      sponsoredFacility
    });
  } catch (error) {
    console.error('Error updating sponsored facility:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update sponsored facility'
    });
  }
});

// Approve/Deactivate sponsored facility
router.patch('/sponsored-facilities/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const sponsoredFacility = await SponsoredFacility.findByIdAndUpdate(
      id,
      { isActive },
      { new: true }
    ).populate('facility', 'provider_name city_town state zip_code telephone_number overall_rating');

    if (!sponsoredFacility) {
      return res.status(404).json({
        success: false,
        error: 'Sponsored facility not found'
      });
    }

    res.json({
      success: true,
      sponsoredFacility,
      message: `Sponsorship ${isActive ? 'approved' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Error updating sponsorship status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update sponsorship status'
    });
  }
});

// Delete sponsored facility
router.delete('/sponsored-facilities/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sponsoredFacility = await SponsoredFacility.findByIdAndDelete(id);

    if (!sponsoredFacility) {
      return res.status(404).json({
        success: false,
        error: 'Sponsored facility not found'
      });
    }

    res.json({
      success: true,
      message: 'Sponsored facility deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting sponsored facility:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete sponsored facility'
    });
  }
});



export default router;