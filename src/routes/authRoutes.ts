import { Router } from "express";
import { register, login } from "../controllers/authController";
import { User, IUser } from '../models/User';

const router = Router();

router.post("/register", register);
router.post("/login", login);

// Add this route to create initial admin user (run once)
router.post('/setup-admin', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Check if admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      return res.status(400).json({ message: 'Admin user already exists' });
    }

    // Create admin user
    const adminUser = new User({
      name,
      email,
      password,
      role: 'admin'
    });

    await adminUser.save();

    res.status(201).json({ 
      message: 'Admin user created successfully',
      user: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role
      }
    });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


export default router;
