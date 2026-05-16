import "dotenv/config";
import cron from "node-cron";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

export function startBackupCron() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const backupPath = path.join(__dirname, "backup.js");
    const schedule = process.env.BACKUP_CRON_SCHEDULE || "0 14 * * *";
    const timezone = process.env.BACKUP_CRON_TIMEZONE || "Asia/Kolkata";

    if (!cron.validate(schedule)) {
        throw new Error(`Invalid BACKUP_CRON_SCHEDULE: ${schedule}`);
    }

    console.log(`Backup cron initialized: ${schedule} (${timezone})`);

    cron.schedule(
        schedule,
        () => {
            console.log("Running backup at:", new Date().toISOString());

            exec(`node ${backupPath}`, (error, stdout, stderr) => {
                if (error) {
                    console.error("Backup Error:", error);
                    return;
                }

                if (stderr) console.error("Backup stderr:", stderr);

                console.log("Backup completed successfully");
                console.log(stdout);
            });
        },
        {
            timezone,
        }
    );
}


// Cron Schedule
// ┌───────────── minute (0 - 59)
// │ ┌─────────── hour (0 - 23)
// │ │ ┌───────── day of month (1 - 31)
// │ │ │ ┌─────── month (1 - 12)
// │ │ │ │ ┌───── day of week (0 - 7) (Sunday = 0 or 7)
// │ │ │ │ │
// │ │ │ │ │
// * * * * *
