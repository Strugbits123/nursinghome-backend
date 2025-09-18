import { Router } from "express";
import { login } from "../controllers/authController";

const router = Router();

// Login route
router.post("/login", login);

export default router;