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

// Cron jobs
// import "./cron/facilityCron";

const app: Application = express();
// const corsOptions = {
//     origin: 'http://localhost:3000', 
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


app.use(errorHandler);
console.log("MONGO_URI from env:", JSON.stringify(process.env.MONGO_URI));

const MONGODB_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/nursinghome";
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    console.log('✅ MongoDB Connected successfully.');
        try {
            await Facility.syncIndexes();
            console.log("✅ Geo Index confirmed and synced.");
        } catch (err) {
            // Log if syncing fails, but allow the app to run
            console.error("Index sync failed:", err);
        }
        startFacilitySyncCron();

    // Start Express server
    const PORT: number = Number(process.env.PORT) || 5000;
    app.listen(PORT, '0.0.0.0', () =>
      console.log(`🚀 Server running on port ${PORT}`)
    );    
    // app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
};


connectDB();