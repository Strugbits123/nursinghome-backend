import dotenv from "dotenv";
dotenv.config();

interface Config {
  PORT: number;
  MONGO_URI: string;
  CMS_API_KEY: string;
  GOOGLE_API_KEY: string;
  GOOGLE_MAPS_API_KEY: string;
  JWT_SECRET: string;
  GEMINI_API_KEY: string;
}

const config: Config = {
  PORT: Number(process.env.PORT) || 5000,
  MONGO_URI: process.env.MONGO_URI || "",
  CMS_API_KEY: process.env.CMS_API_KEY || "",
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || "",
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
  JWT_SECRET: process.env.JWT_SECRET || "default_secret",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
};

export default config;