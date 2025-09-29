import cron from "node-cron";
import { syncFacilities } from "../services/cmsService";


const CRON_SCHEDULE = "* * * * *"; 

export const startFacilitySyncCron = () => {
  console.log(`Scheduling CMS facility sync job to run at: ${CRON_SCHEDULE}`);

  const job = cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`--- CRON JOB START: CMS Facility Sync (${new Date().toISOString()}) ---`);
    try {
      await syncFacilities();
    } catch (error) {
      console.error('Error running CMS facility sync cron job:', error);
    }
    // stop the job after first execution
    // job.stop();
    console.log("🛑 Facility sync cron stopped after first run.");

    console.log(`--- CRON JOB END: CMS Facility Sync (${new Date().toISOString()}) ---`);
  });
};