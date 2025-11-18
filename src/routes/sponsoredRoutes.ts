import express, { Request, Response } from 'express';
import { SponsoredFacility } from '../models/SponsoredFacility';
import NursingFacility from '../models/NursingFacility';
import { protect } from '../middleware/authMiddleware';
import { requireAdmin } from '../middleware/adminMiddleware';
import nodemailer from 'nodemailer';

const router = express.Router();

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Interface for request body
interface SponsorFacilityRequest {
  name: string;
  email: string;
  phone: string;
  facilityName: string;
  location: string;
  message?: string;
  facilityId?: string;
}

interface ApproveSponsorshipRequest {
  facilityId: string;
  durationDays?: number;
}

// Submit sponsorship form
router.post('/sponsor-facility', async (req: Request<{}, {}, SponsorFacilityRequest>, res: Response) => {
  try {
    const { name, email, phone, facilityName, location, message, facilityId } = req.body;
    console.log('Sponsorship request received:', req.body);

    let facility;

    // Option 1: Use facilityId if provided (most reliable)
    if (facilityId) {
      facility = await NursingFacility.findById(facilityId);
      if (!facility) {
        return res.status(404).json({
          error: 'Facility not found with the provided ID.'
        });
      }
    } else {
      // Option 2: Parse location and search by name + location components
      const locationParts = location.split(',');
      const city = locationParts[0]?.trim();
      const stateZip = locationParts[1]?.trim();
      
      let state, zipCode;
      if (stateZip) {
        const stateZipParts = stateZip.split(' ');
        state = stateZipParts[0]?.trim();
        zipCode = stateZipParts[1]?.trim();
      }

      console.log('Parsed location:', { city, state, zipCode });

      // Build search conditions
      const searchConditions: any = {
        provider_name: new RegExp(facilityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      };

      // Add location conditions
      const locationConditions = [];
      if (city) locationConditions.push({ city_town: new RegExp(city, 'i') });
      if (state) locationConditions.push({ state: new RegExp(state, 'i') });
      if (zipCode) locationConditions.push({ zip_code: new RegExp(zipCode, 'i') });

      if (locationConditions.length > 0) {
        searchConditions.$or = locationConditions;
      }

      console.log('Search conditions:', searchConditions);

      facility = await NursingFacility.findOne(searchConditions);

      if (!facility) {
        return res.status(404).json({
          error: 'Facility not found. Please check the facility name and location.',
          details: {
            searchedName: facilityName,
            searchedLocation: location,
            parsedLocation: { city, state, zipCode }
          }
        });
      }
    }

    console.log('Facility found:', facility.provider_name);

    // 2. Send email to admin
    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              margin: 0;
              padding: 0;
              background-color: #f4f4f4;
            }
            .container { 
              max-width: 600px; 
              margin: 0 auto; 
              background: white;
            }
            .header { 
              background: linear-gradient(135deg, #C71F37, #a51a2f); 
              color: white; 
              padding: 30px 20px; 
              text-align: center;
            }
            .content { 
              padding: 30px; 
            }
            .field { 
              margin-bottom: 20px; 
              padding-bottom: 20px;
              border-bottom: 1px solid #eee;
            }
            .label { 
              font-weight: bold; 
              color: #C71F37; 
              display: block;
              margin-bottom: 5px;
            }
            .footer { 
              text-align: center; 
              margin-top: 30px; 
              color: #666;
              padding: 20px;
              background: #f9f9f9;
            }
            .facility-details {
              background: #f8f9fa;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
            }
            .urgency {
              background: #fff3cd;
              padding: 15px;
              border-radius: 5px;
              border-left: 4px solid #ffc107;
              margin: 20px 0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>New Facility Sponsorship Request</h1>
              <p>You have received a new sponsorship submission</p>
            </div>
            
            <div class="content">
              <div class="urgency">
                <strong>Action Required:</strong> Please review this sponsorship request within 24 hours.
              </div>
              
              <div class="field">
                <span class="label">Facility Name:</span>
                <span>${facility.provider_name}</span>
              </div>
              
              <div class="field">
                <span class="label">CMS Certification Number:</span>
                <span>${facility.cms_certification_number_ccn}</span>
              </div>
              
              <div class="field">
                <span class="label">Location:</span>
                <span>${facility.city_town}, ${facility.state} ${facility.zip_code}</span>
              </div>
              
              <div class="field">
                <span class="label">Contact Person:</span>
                <span>${name}</span>
              </div>
              
              <div class="field">
                <span class="label">Email:</span>
                <span><a href="mailto:${email}">${email}</a></span>
              </div>
              
              <div class="field">
                <span class="label">Phone:</span>
                <span><a href="tel:${phone}">${phone}</a></span>
              </div>
              
              <div class="field">
                <span class="label">Additional Message:</span>
                <p>${message || 'No additional message provided.'}</p>
              </div>
              
              <div class="facility-details">
                <h3 style="color: #C71F37; margin-top: 0;">Facility Details</h3>
                <ul style="list-style: none; padding: 0;">
                  <li><strong>Address:</strong> ${facility.provider_address || 'N/A'}</li>
                  <li><strong>Phone:</strong> ${facility.telephone_number || 'N/A'}</li>
                  <li><strong>Ownership:</strong> ${facility.ownership_type || 'N/A'}</li>
                  <li><strong>Certified Beds:</strong> ${facility.number_of_certified_beds || 'N/A'}</li>
                  <li><strong>Overall Rating:</strong> ${facility.overall_rating || 'N/A'}/5</li>
                </ul>
              </div>
            </div>
            
            <div class="footer">
              <p><strong>Submission Time:</strong> ${new Date().toLocaleString()}</p>
              <p>Please review and respond to this sponsorship request within 24 hours.</p>
              <p style="color: #C71F37; font-size: 12px;">This is an automated message from CareFinder System</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Send email with proper error handling
    console.log('Attempting to send email...');
    console.log('From:', process.env.EMAIL_USER);
    console.log('To: carnav@gmail.com');

    let emailSent = false;
    try {
      const emailResult = await transporter.sendMail({
        from: email,
        to: process.env.EMAIL_USER,
        subject: `New Sponsorship Request: ${facility.provider_name}`,
        html: emailHtml,
        replyTo: email,
      });

      console.log('Email sent successfully! Message ID:', emailResult.messageId);
      emailSent = true;
    } catch (emailError) {
      console.error('EMAIL SEND FAILED:', emailError);
    }

    // 3. Update NursingFacility with sponsorship submission
    try {
      const updateData: any = {
        $set: {
          sponsoredBy: {
            name,
            email,
            phone,
            message,
            submittedAt: new Date(),
            status: 'pending'
          },
          lastSponsoredSubmission: new Date()
        }
      };

      await NursingFacility.findByIdAndUpdate(facility._id, updateData);
      console.log('NursingFacility updated with sponsorship data');
    } catch (updateError) {
      console.error('Failed to update NursingFacility:', updateError);
    }

    // 4. Create SponsoredFacility record (pending approval)
    let sponsoredFacility = null;
    try {
      // Generate default title and description if not provided
      const sponsorshipTitle = facilityName || `Sponsorship Request for ${facility.provider_name}`;
      const sponsorshipDescription = message || 
        `Sponsorship request submitted by ${name}. ${message ? `Message: ${message}` : ''}`;

      // Set sponsorship period (30 days from approval, but mark as inactive for now)
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 30); // 30 days from now

      // Create sponsoredBy object according to the schema
      const sponsoredByData = {
        name,
        email,
        phone,
        submittedAt: new Date()
      };

      sponsoredFacility = await SponsoredFacility.create({
        facility: facility._id,
        title: sponsorshipTitle,
        description: sponsorshipDescription,
        startDate: startDate,
        endDate: endDate,
        isActive: false, // Not active until approved by admin
        priority: 1,
        clicks: 0,
        impressions: 0,
        sponsoredBy: sponsoredByData // Add sponsoredBy data
      });

      console.log('SponsoredFacility record created:', sponsoredFacility._id);
    } catch (sponsoredError) {
      console.error('Failed to create SponsoredFacility record:', sponsoredError);
    }

    // 5. Send success response
    res.status(200).json({
      success: true,
      message: 'Sponsorship request submitted successfully! We will review your request and contact you within 24 hours.',
      facility: {
        id: facility._id,
        name: facility.provider_name,
        location: `${facility.city_town}, ${facility.state}`,
        phone: facility.telephone_number
      },
      emailSent: emailSent,
      sponsoredFacilityCreated: !!sponsoredFacility,
      nextSteps: 'Our team will review your request and contact you to discuss sponsorship details and activation.'
    });

  } catch (error) {
    console.error('Sponsorship submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit sponsorship request. Please try again later.'
    });
  }
});

// Add this to your sponsoredRoutes.ts - BEFORE your existing route
router.get('/test', (req: Request, res: Response) => {
  res.json({ 
    message: '✅ Sponsored routes are working!',
    timestamp: new Date().toISOString(),
    path: '/api/sponsored/test'
  });
});

// Add this test POST endpoint
router.post('/test-post', (req: Request, res: Response) => {
  console.log('✅ Test POST endpoint hit!', req.body);
  res.json({ 
    message: '✅ POST endpoint is working!',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// Add this test function to your SponsoredModal
const testPostEndpoint = async () => {
  try {
    const testData = {
      name: "Test User",
      email: "test@test.com",
      phone: "1234567890",
      facilityName: "Test Facility",
      location: "New York, NY",
      message: "Test message"
    };

    console.log('🧪 Testing POST endpoint...');
    
    const response = await fetch('http://localhost:5000/api/sponsored/sponsor-facility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testData)
    });

    console.log('📤 Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ POST test failed:', errorText);
    } else {
      const data = await response.json();
      console.log('✅ POST test successful:', data);
    }
  } catch (error) {
    console.error('❌ POST test error:', error);
  }
};



// Admin endpoint to approve sponsorship
router.post('/approve-sponsorship', async (req: Request<{}, {}, ApproveSponsorshipRequest>, res: Response) => {
  try {
    const { facilityId, durationDays = 30 } = req.body;

    const facility = await NursingFacility.findById(facilityId);
    
    if (!facility) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    // Set sponsorship details
    const updateData: any = {
      sponsored: true,
      sponsoredAt: new Date(),
      sponsoredExpiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
    };

    await NursingFacility.findByIdAndUpdate(facilityId, updateData);

    // Send confirmation email to the submitter
    if (facility.sponsoredBy) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER!,
        to: facility.sponsoredBy.email,
        subject: `Sponsorship Approved: ${facility.provider_name}`,
        html: `
          <h2>🎉 Your Sponsorship Has Been Approved!</h2>
          <p>Dear ${facility.sponsoredBy.name},</p>
          <p>We're excited to inform you that your facility <strong>${facility.provider_name}</strong> has been approved for sponsorship!</p>
          <p>Your facility will now be featured prominently in search results until ${updateData.sponsoredExpiresAt.toLocaleDateString()}.</p>
          <p>Thank you for choosing to sponsor with us!</p>
        `
      });
    }

    res.status(200).json({
      success: true,
      message: 'Sponsorship approved successfully',
      facility: {
        name: facility.provider_name,
        sponsored: true,
        expiresAt: updateData.sponsoredExpiresAt
      }
    });

  } catch (error) {
    console.error('Sponsorship approval error:', error);
    res.status(500).json({ error: 'Failed to approve sponsorship' });
  }
});

// GET /api/sponsored - Get active sponsored facilities (public)
router.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    
    const sponsored = await SponsoredFacility.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now }
    })
    .populate('facility', 'provider_name city_town state overall_rating')
    .sort({ priority: -1, createdAt: -1 })
    .limit(10);

    // Increment impressions
    await SponsoredFacility.updateMany(
      { _id: { $in: sponsored.map(s => s._id) } },
      { $inc: { impressions: 1 } }
    );

    res.json(sponsored);
  } catch (error) {
    console.error('Get sponsored facilities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/sponsored/:id/click - Track sponsored facility click
router.post('/:id/click', async (req: Request<{ id: string }>, res: Response) => {
  try {
    await SponsoredFacility.findByIdAndUpdate(
      req.params.id,
      { $inc: { clicks: 1 } }
    );

    res.json({ message: 'Click tracked' });
  } catch (error) {
    console.error('Track click error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/sponsored/admin/all - Get all sponsored facilities (admin only)
router.get('/admin/all', protect, requireAdmin, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status as string;

    const filter: any = {};
    if (status === 'active') {
      const now = new Date();
      filter.isActive = true;
      filter.startDate = { $lte: now };
      filter.endDate = { $gte: now };
    } else if (status === 'inactive') {
      filter.isActive = false;
    } else if (status === 'expired') {
      const now = new Date();
      filter.endDate = { $lt: now };
    }

    const sponsored = await SponsoredFacility.find(filter)
      .populate('facility', 'provider_name city_town state')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await SponsoredFacility.countDocuments(filter);

    res.json({
      sponsored,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalSponsored: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get admin sponsored error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/sponsored - Create new sponsored facility (admin only)
router.post('/', protect, requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      facilityId,
      title,
      description,
      image,
      startDate,
      endDate,
      priority
    } = req.body;

    // Verify facility exists
    const facility = await NursingFacility.findById(facilityId);
    if (!facility) {
      return res.status(404).json({ message: 'Facility not found' });
    }

    const sponsored = new SponsoredFacility({
      facility: facilityId,
      title,
      description,
      image,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      priority: priority || 1
    });

    await sponsored.save();
    
    // Populate facility details in response
    await sponsored.populate('facility', 'provider_name city_town state');
    
    res.status(201).json(sponsored);
  } catch (error) {
    console.error('Create sponsored error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/sponsored/:id - Update sponsored facility (admin only)
router.put('/:id', protect, requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const sponsored = await SponsoredFacility.findById(req.params.id);
    
    if (!sponsored) {
      return res.status(404).json({ message: 'Sponsored facility not found' });
    }

    // If facility ID is being updated, verify new facility exists
    if (req.body.facilityId) {
      const facility = await NursingFacility.findById(req.body.facilityId);
      if (!facility) {
        return res.status(404).json({ message: 'Facility not found' });
      }
      req.body.facility = req.body.facilityId;
      delete req.body.facilityId;
    }

    const updatedSponsored = await SponsoredFacility.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    ).populate('facility', 'provider_name city_town state');

    res.json(updatedSponsored);
  } catch (error) {
    console.error('Update sponsored error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/sponsored/:id - Delete sponsored facility (admin only)
router.delete('/:id', protect, requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const sponsored = await SponsoredFacility.findById(req.params.id);
    
    if (!sponsored) {
      return res.status(404).json({ message: 'Sponsored facility not found' });
    }

    await SponsoredFacility.findByIdAndDelete(req.params.id);
    res.json({ message: 'Sponsored facility deleted successfully' });
  } catch (error) {
    console.error('Delete sponsored error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;