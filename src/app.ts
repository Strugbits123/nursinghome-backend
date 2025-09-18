import dotenv from "dotenv";
dotenv.config();

import express, { Application, Request, Response } from "express";
import cors from "cors";
import mongoose from "mongoose";

// Controllers & Routes
import facilityRoutes from "./routes/facilityRoutes";
import aiRoutes from "./routes/aiRoutes";
import googleRoutes from "./routes/googleRoutes";
import authRoutes from "./routes/authRoutes";

// Middlewares
import { errorHandler } from "./middlewares/errorHandler";
import { protect } from "./middlewares/authMiddleware";
import { findPlaceIdByText } from "./services/googleService"; 
import placeRoutes from "./routes/placeRoutes";

// Cron jobs
// import "./cron/facilityCron";

const app: Application = express();

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/facilities", facilityRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/google", googleRoutes);


app.use("/api/place", placeRoutes);


app.use(errorHandler);

const mongoUri: string = process.env.MONGO_URI || "";
mongoose
  .connect(mongoUri)
  .then(() => console.log("MongoDB connected"))
  .catch((err: any) => console.error("MongoDB connection error:", err));

const PORT: number = Number(process.env.PORT) || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));