import { Request, Response } from "express";
import jwt from "jsonwebtoken";

interface JwtPayload {
  id: number;
  email: string;
  role: string;
}

export const login = (req: Request, res: Response): Response => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (email === "admin@test.com" && password === "123456") {
    const payload: JwtPayload = { id: 1, email, role: "admin" };
    const token = jwt.sign(payload, process.env.JWT_SECRET || "default_secret", { expiresIn: "1d" });

    return res.json({ success: true, token });
  }

  return res.status(401).json({ success: false, message: "Invalid credentials" });
};
