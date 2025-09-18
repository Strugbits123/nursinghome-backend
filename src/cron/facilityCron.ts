import cron from "node-cron";
import { syncFacilities } from "../services/cmsService";

// Run every minute for testing (change to "* * * * *" for every minute)

// cron.schedule("* * * * *", async () => {
//   console.log("⏰ Running nightly CMS sync...");
//   try {
//     const result = await syncFacilities();
//     console.log("✅ CMS Sync complete:", result);
//   } catch (err: any) {
//     console.error("❌ CMS Sync failed:", err.message);
//   }
// });
