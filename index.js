import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import archiver from "archiver";
import { startBackupCron } from "./cron-backup.js";

function normalizeBasePath(basePath) {
    const trimmed = String(basePath || "/pg-worker").trim();
    if (!trimmed || trimmed === "/") return "/";
    return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const app = express();
const PORT = process.env.DASHBOARD_PORT || 10000;
const ROUTE_BASE_PATH = normalizeBasePath(process.env.DASHBOARD_BASE_PATH);
const VIEW_BASE_PATH = ROUTE_BASE_PATH === "/" ? "" : ROUTE_BASE_PATH;
const router = express.Router();

const ROOT = process.cwd();
const BACKUP_DIR = path.join(ROOT, "backups");
const LOG_DIR = path.join(ROOT, "logs");

startBackupCron()

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.use(ROUTE_BASE_PATH, express.static(path.join(ROOT, "public")));

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

    if (!fs.existsSync(LOG_DIR)) return { success, failure };

    const logFiles = fs.readdirSync(LOG_DIR)
        .filter(file =>
            file.endsWith(".json") &&
            !file.startsWith(".") &&
            !file.toLowerCase().includes("audit")
        );

    for (const file of logFiles) {
        const filePath = path.join(LOG_DIR, file);
        const lines = fs.readFileSync(filePath, "utf-8").split("\n");

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const entry = JSON.parse(line);
                const event = entry.message?.event;

                if (event === "backup_success") success++;
                if (event === "backup_failed") failure++;
            } catch {
                // ignore malformed lines
            }
        }
    }

    return { success, failure };
}



router.get("/", (req, res) => {
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
        basePath: VIEW_BASE_PATH,
    });
});

// app.get("/backups", (req, res) => {
//     const backupRoot = path.resolve("./backups");

//     const backups = [];

//     if (fs.existsSync(backupRoot)) {
//         const dates = fs.readdirSync(backupRoot);

//         dates.forEach((date) => {
//             const datePath = path.join(backupRoot, date);
//             if (!fs.statSync(datePath).isDirectory()) return;

//             const dbs = fs.readdirSync(datePath);

//             dbs.forEach((db) => {
//                 const dbPath = path.join(datePath, db);
//                 const files = fs.readdirSync(dbPath);

//                 files.forEach((file) => {
//                     const filePath = path.join(dbPath, file);
//                     const size = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);

//                     backups.push({
//                         date,
//                         database: db,
//                         file,
//                         size,
//                         url: `/api/backups/download?date=${date}&db=${db}&file=${file}`
//                     });
//                 });
//             });
//         });
//     }

//     res.render("backups", { backups });
// });
router.get("/backups", (req, res) => {
    const backupRoot = path.resolve("./backups");

    const groupedBackups = {};

    if (fs.existsSync(backupRoot)) {
        const dates = fs.readdirSync(backupRoot).sort((a, b) => new Date(b) - new Date(a));

        dates.forEach((date) => {
            const datePath = path.join(backupRoot, date);
            if (!fs.statSync(datePath).isDirectory()) return;

            groupedBackups[date] = [];

            const dbs = fs.readdirSync(datePath);

            dbs.forEach((db) => {
                const dbPath = path.join(datePath, db);
                const files = fs.readdirSync(dbPath);

                files.forEach((file) => {
                    const filePath = path.join(dbPath, file);
                    const size = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);

                    groupedBackups[date].push({
                        database: db,
                        file,
                        size,
                        url: `${VIEW_BASE_PATH}/api/backups/download?date=${date}&db=${db}&file=${file}`
                    });
                });
            });
        });
    }

    res.render("backups", { backups: groupedBackups, basePath: VIEW_BASE_PATH });
});

router.get("/logs/:filename", (req, res) => {
    const file = req.params.filename;
    const filePath = path.join(LOG_DIR, file);

    if (!filePath.startsWith(LOG_DIR) || !fs.existsSync(filePath)) {
        return res.status(404).send("Log file not found");
    }

    const content = fs.readFileSync(filePath, "utf-8");
    res.type("text/plain").send(content);
});

router.get("/api/backups/download-date/:date", (req, res) => {

    const date = req.params.date;
    const dir = path.join(process.cwd(), "backups", date);

    if (!fs.existsSync(dir)) {
        return res.status(404).send("Backup date not found");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=backups-${date}.zip`);

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(res);
    archive.directory(dir, false);
    archive.finalize();
});

router.get("/api/stats", (req, res) => {
    const { success, failure } = getBackupStats();

    res.json({
        backups: {
            success,
            failure
        },
        time: dayjs().format("HH:mm:ss")
    });
});

router.get("/api/backups", (req, res) => {
    const backupRoot = path.resolve("./backups");

    if (!fs.existsSync(backupRoot)) {
        return res.json({ backups: [] });
    }

    const result = [];

    const dates = fs.readdirSync(backupRoot);

    dates.forEach((date) => {
        const datePath = path.join(backupRoot, date);
        if (!fs.statSync(datePath).isDirectory()) return;

        const dbs = fs.readdirSync(datePath);

        dbs.forEach((db) => {
            const dbPath = path.join(datePath, db);

            const files = fs.readdirSync(dbPath);

            files.forEach((file) => {
                result.push({
                    date,
                    database: db,
                    file,
                    downloadUrl: `${VIEW_BASE_PATH}/api/backups/download?date=${date}&db=${db}&file=${file}`
                });
            });
        });
    });

    res.json({
        backups: result
    });
});

router.get("/api/backups/download", (req, res) => {
    const { date, db, file } = req.query;

    if (!date || !db || !file) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const filePath = path.join(
        process.cwd(),
        "backups",
        String(date),
        String(db),
        String(file)
    );

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Backup not found" });
    }

    res.download(filePath);
});

if (ROUTE_BASE_PATH !== "/") {
    app.get("/", (req, res) => {
        res.redirect(ROUTE_BASE_PATH);
    });
}

app.use(ROUTE_BASE_PATH, router);

app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}${VIEW_BASE_PATH || "/"}`);
});
