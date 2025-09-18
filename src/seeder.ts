import mongoose from "mongoose";
import dotenv from "dotenv";
import Facility, { IFacility } from "./models/facilityModel";
import { connectDB } from "./config/db";

dotenv.config();
connectDB();

const facilities: Partial<IFacility>[] = [
  {
    cmsId: "123456",
    name: "Sunrise Nursing Home",
    address: "123 Main St",
    city: "New York",
    state: "NY",
    zip: "10001",
    phone: "123-456-7890",
    ownership: "For Profit",
    bedCount: 120,
    rating: 4,
    staffing: {
      nurses: 20,
      assistants: 30,
    },
  },
  {
    cmsId: "789012",
    name: "Green Valley Care Center",
    address: "456 Oak Ave",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
    phone: "987-654-3210",
    ownership: "Non Profit",
    bedCount: 95,
    rating: 5,
    staffing: {
      nurses: 15,
      assistants: 25,
    },
  },
];

const importData = async (): Promise<void> => {
  try {
    // await Facility.deleteMany(); 
    await Facility.insertMany(facilities);
    console.log("✅ Data Imported Successfully!");
    process.exit();
  } catch (error: any) {
    console.error("❌ Error with seeder:", error.message || error);
    process.exit(1);
  }
};

importData();
