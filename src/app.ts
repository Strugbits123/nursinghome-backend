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
import { errorHandler } from "./middleware/errorHandler";
import { protect } from "./middleware/authMiddleware";
import { findPlaceIdByText } from "./services/googleService"; 
import placeRoutes from "./routes/placeRoutes";
import Facility from './models/NursingFacility';

import { startFacilitySyncCron } from './cron/syncJob';

import { getCache, setCache } from "./config/redisClient";

// Cron jobs
import "./cron/facilityCron";

const app: Application = express();
// const corsOptions = {
//     origin: 'https://carenav.io/', 
//     methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
//     allowedHeaders: 'Content-Type,Authorization', 
//     credentials: true, 
// };

// 2. Apply the CORS middleware
// app.use(cors(corsOptions));
app.use(cors());
app.use(express.json());

app.get('/', (req: Request, res: Response) => {
  res.send('Backend up ✅ MongoDB connected');
});

app.get('/ping', (req: Request, res: Response) => {
  const ready = mongoose.connection.readyState; // 1 means connected
  res.json({ status: ready === 1 ? 'ok' : 'not connected' });
});

app.use("/api/auth", authRoutes);
app.use("/api/facilities", facilityRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/google", googleRoutes);


app.use("/api/place", placeRoutes);

app.get("/api/debug/cache/:key", async (req, res) => {
  const { key } = req.params;
  try {
    const value = await getCache(key);
    if (!value) return res.status(404).json({ message: "Key not found" });
    return res.json(JSON.parse(value));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    res.status(500).json({ error: message });
  }
});


app.use(errorHandler);
console.log("MONGO_URI from env:", JSON.stringify(process.env.MONGO_URI));

const MONGODB_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/nursinghome";
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    console.log('✅ MongoDB Connected successfully.');
    // ✅ Start cron job after successful DB connection
    startFacilitySyncCron();
       
    const PORT: number = Number(process.env.PORT) || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
};


connectDB();