import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';

interface JwtPayload {
  id: string;
  email: string;
  role: string;
}

// REGISTER
export const register = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    // Check existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    // Create user (password hashing is handled by the pre-save hook in the model)
    const user = new User({
      name,
      email,
      password: password, // The plain password before the hook runs
      role: role || 'user',
    });

    await user.save();

    return res.status(201).json({ success: true, message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// LOGIN
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Find user and EXPLICITLY SELECT THE PASSWORD field to bypass 'select: false'
    const user = await User.findOne({ email }).select('+password'); 
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Compare passwords using the model's custom method
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Create JWT payload
    const payload: JwtPayload = {
      id: String(user._id),
      email: user.email,
      role: user.role,
    };

    // Sign and create JWT
    const token = jwt.sign(payload, process.env.JWT_SECRET || 'default_secret', {
      expiresIn: '1d', // Token expires in 1 day
    });

    return res.json({ success: true, token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};