import cron from "node-cron";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

export function startBackupCron() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const backupPath = path.join(__dirname, "backup.js");

    console.log("Backup cron initialized...");

    cron.schedule(
        "11 18 * * *",
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
            timezone: "Asia/Kolkata",
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