import express from "express";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

const ROOT = process.cwd();
const BACKUP_DIR = path.join(ROOT, "backups");
const LOG_DIR = path.join(ROOT, "logs");

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.use(express.static(path.join(ROOT, "public")));

function getDirectorySize(dir) {
    let total = 0;
    if (!fs.existsSync(dir)) return 0;

    fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            total += getDirectorySize(filePath);
        } else {
            total += stat.size;
        }
    });

    return total;
}

function getBackupStats() {
    let success = 0;
    let failure = 0;

    const logFile = path.join(LOG_DIR, "app.log");
    if (!fs.existsSync(logFile)) return { success, failure };

    const lines = fs.readFileSync(logFile, "utf-8").split("\n");

    for (const line of lines) {
        if (line.includes("backup_success")) success++;
        if (line.includes("backup_failed")) failure++;
    }

    return { success, failure };
}

app.get("/", (req, res) => {
    const backupDates = fs.existsSync(BACKUP_DIR)
        ? fs.readdirSync(BACKUP_DIR)
        : [];

    let totalBackups = 0;

    backupDates.forEach(date => {
        const datePath = path.join(BACKUP_DIR, date);
        fs.readdirSync(datePath).forEach(db => {
            totalBackups += fs.readdirSync(path.join(datePath, db)).length;
        });
    });

    // Logs
    const logs = fs.existsSync(LOG_DIR)
        ? fs.readdirSync(LOG_DIR)
            .filter(file =>
                fs.statSync(path.join(LOG_DIR, file)).isFile() &&
                !file.toLowerCase().includes("audit")
            )
            .map(file => ({
                name: file,
                size: (fs.statSync(path.join(LOG_DIR, file)).size / 1024).toFixed(2),
            }))
        : [];

    res.render("dashboard", {
        stats: {
            totalBackups,
            totalBackupSizeMB: (getDirectorySize(BACKUP_DIR) / 1024 / 1024).toFixed(2),
            logFiles: logs.length,
            serverTime: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        },
        backupDates,
        logs,
    });
});

app.get("/logs/:filename", (req, res) => {
    const file = req.params.filename;
    const filePath = path.join(LOG_DIR, file);

    if (!filePath.startsWith(LOG_DIR) || !fs.existsSync(filePath)) {
        return res.status(404).send("Log file not found");
    }

    const content = fs.readFileSync(filePath, "utf-8");
    res.type("text/plain").send(content);
});

app.get("/api/stats", (req, res) => {
    const backupStats = getBackupStats();

    res.json({
        backups: backupStats,
        sizeMB: (getDirectorySize(BACKUP_DIR) / 1024 / 1024).toFixed(2),
        time: dayjs().format("HH:mm:ss"),
    });
});

app.listen(PORT, () => {
    console.log(`Dashboard running on port : ${PORT}`);
});
