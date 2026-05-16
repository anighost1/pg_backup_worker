import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import archiver from "archiver";
import crypto from "crypto";
import { startBackupCron } from "./cron-backup.js";

function normalizeBasePath(basePath) {
    const trimmed = String(basePath || "/pg-worker").trim();
    if (!trimmed || trimmed === "/") return "/";
    return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function routePath(pathname) {
    return ROUTE_BASE_PATH === "/" ? pathname : `${ROUTE_BASE_PATH}${pathname}`;
}

function timingSafeEqualString(a, b) {
    const first = Buffer.from(String(a));
    const second = Buffer.from(String(b));

    if (first.length !== second.length) return false;

    return crypto.timingSafeEqual(first, second);
}

function getSessionSecret() {
    return process.env.DASHBOARD_SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
}

function getCookie(req, name) {
    const cookies = req.headers.cookie?.split(";") || [];

    for (const cookie of cookies) {
        const [rawKey, ...rawValue] = cookie.trim().split("=");
        if (rawKey === name) return decodeURIComponent(rawValue.join("="));
    }

    return "";
}

function signSession(value) {
    const sessionSecret = getSessionSecret();

    if (!sessionSecret) return "";

    return crypto
        .createHmac("sha256", sessionSecret)
        .update(value)
        .digest("base64url");
}

function createSessionToken(username) {
    const payload = Buffer.from(JSON.stringify({
        username,
        expiresAt: Date.now() + 1000 * 60 * 60 * 8,
        nonce: crypto.randomBytes(16).toString("hex"),
    })).toString("base64url");
    const signature = signSession(payload);

    return `${payload}.${signature}`;
}

function isValidSession(req) {
    if (!getSessionSecret()) return false;

    const token = getCookie(req, "pg_worker_session");
    const [payload, signature] = token.split(".");

    if (!payload || !signature || !timingSafeEqualString(signature, signSession(payload))) {
        return false;
    }

    try {
        const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
        return session.expiresAt > Date.now() && session.username === process.env.DASHBOARD_USERNAME;
    } catch {
        return false;
    }
}

function getSessionCookieOptions(maxAgeSeconds) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `HttpOnly; SameSite=Strict; Path=${ROUTE_BASE_PATH}; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSession(res) {
    res.setHeader("Set-Cookie", `pg_worker_session=; ${getSessionCookieOptions(0)}`);
}

const failedLogins = new Map();

function getLoginAttemptsKey(req) {
    return req.ip || req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
    const attempt = failedLogins.get(getLoginAttemptsKey(req));
    return attempt && attempt.count >= 5 && attempt.lockedUntil > Date.now();
}

function recordFailedLogin(req) {
    const key = getLoginAttemptsKey(req);
    const now = Date.now();
    const current = failedLogins.get(key) || { count: 0, firstFailedAt: now, lockedUntil: 0 };
    const withinWindow = now - current.firstFailedAt < 1000 * 60 * 10;
    const count = withinWindow ? current.count + 1 : 1;

    failedLogins.set(key, {
        count,
        firstFailedAt: withinWindow ? current.firstFailedAt : now,
        lockedUntil: count >= 5 ? now + 1000 * 60 * 5 : 0,
    });
}

function clearFailedLogins(req) {
    failedLogins.delete(getLoginAttemptsKey(req));
}

function requireLogin(req, res, next) {
    const expectedUsername = process.env.DASHBOARD_USERNAME;
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const sessionSecret = getSessionSecret();

    if (!expectedUsername || !expectedPassword || !sessionSecret) {
        return res.status(503).send("Dashboard authentication is not configured");
    }

    if (!isValidSession(req)) {
        const returnTo = encodeURIComponent(req.originalUrl || `${VIEW_BASE_PATH}/`);
        return res.redirect(`${VIEW_BASE_PATH}/login?returnTo=${returnTo}`);
    }

    next();
}

function safeReturnTo(value) {
    if (!value || typeof value !== "string") return `${VIEW_BASE_PATH}/`;
    if (!value.startsWith(`${VIEW_BASE_PATH}/`) || value.startsWith("//")) return `${VIEW_BASE_PATH}/`;
    if (value.startsWith(`${VIEW_BASE_PATH}/login`)) return `${VIEW_BASE_PATH}/`;
    return value;
}

const app = express();
const PORT = process.env.DASHBOARD_PORT || 10000;
const ROUTE_BASE_PATH = normalizeBasePath(process.env.DASHBOARD_BASE_PATH);
const VIEW_BASE_PATH = ROUTE_BASE_PATH === "/" ? "" : ROUTE_BASE_PATH;
const router = express.Router();

app.disable("x-powered-by");

const ROOT = process.cwd();
const BACKUP_DIR = path.join(ROOT, "backups");
const LOG_DIR = path.join(ROOT, "logs");

startBackupCron()

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
});

app.get(routePath("/login"), (req, res) => {
    if (isValidSession(req)) {
        return res.redirect(safeReturnTo(req.query.returnTo));
    }

    res.render("login", {
        basePath: VIEW_BASE_PATH,
        error: req.query.error === "1",
        locked: req.query.locked === "1",
        returnTo: safeReturnTo(req.query.returnTo),
    });
});

app.post(routePath("/login"), (req, res) => {
    const expectedUsername = process.env.DASHBOARD_USERNAME;
    const expectedPassword = process.env.DASHBOARD_PASSWORD;

    if (!expectedUsername || !expectedPassword || !getSessionSecret()) {
        return res.status(503).send("Dashboard authentication is not configured");
    }

    const returnTo = safeReturnTo(req.body.returnTo);

    if (isRateLimited(req)) {
        return res.redirect(`${VIEW_BASE_PATH}/login?locked=1&returnTo=${encodeURIComponent(returnTo)}`);
    }

    const username = String(req.body.username || "");
    const password = String(req.body.password || "");
    const isValidUser = timingSafeEqualString(username, expectedUsername);
    const isValidPassword = timingSafeEqualString(password, expectedPassword);

    if (!isValidUser || !isValidPassword) {
        recordFailedLogin(req);
        return res.redirect(`${VIEW_BASE_PATH}/login?error=1&returnTo=${encodeURIComponent(returnTo)}`);
    }

    clearFailedLogins(req);
    res.setHeader("Set-Cookie", `pg_worker_session=${createSessionToken(username)}; ${getSessionCookieOptions(60 * 60 * 8)}`);
    res.redirect(returnTo);
});

app.post(routePath("/logout"), (req, res) => {
    clearSession(res);
    res.redirect(`${VIEW_BASE_PATH}/login`);
});

app.use(ROUTE_BASE_PATH, requireLogin);
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

function getLogFilePath(filename) {
    const safeName = path.basename(filename);
    const filePath = path.resolve(LOG_DIR, safeName);
    const logRoot = path.resolve(LOG_DIR);

    if (!filePath.startsWith(logRoot) || safeName !== filename || !fs.existsSync(filePath)) {
        return null;
    }

    return filePath;
}

function parseLogFile(filePath) {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const entries = [];
    const summary = {
        total: 0,
        success: 0,
        failed: 0,
        warning: 0,
        info: 0,
        malformed: 0,
    };

    lines.forEach((line, index) => {
        const raw = line.trim();
        if (!raw) return;

        summary.total++;

        try {
            const entry = JSON.parse(raw);
            const message = entry.message || {};
            const event = message.event || "log_entry";
            const level = String(entry.level || "info").toLowerCase();
            const status = event.includes("failed") || level === "error"
                ? "failed"
                : event.includes("success")
                    ? "success"
                    : level === "warn" || level === "warning"
                        ? "warning"
                        : "info";

            summary[status]++;

            entries.push({
                line: index + 1,
                level,
                status,
                event,
                database: message.database || "",
                timestamp: entry.timestamp ? dayjs(entry.timestamp).format("YYYY-MM-DD HH:mm:ss") : "",
                duration: message.durationMs ? `${message.durationMs} ms` : "",
                size: message.sizeMB !== undefined ? `${message.sizeMB} MB` : "",
                file: message.file || "",
                detail: JSON.stringify(entry, null, 2),
            });
        } catch {
            summary.malformed++;
            entries.push({
                line: index + 1,
                level: "invalid",
                status: "failed",
                event: "malformed_json",
                database: "",
                timestamp: "",
                duration: "",
                size: "",
                file: "",
                detail: raw,
            });
        }
    });

    return { entries, summary };
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

router.get("/logs/:filename/raw", (req, res) => {
    const file = req.params.filename;
    const filePath = getLogFilePath(file);

    if (!filePath) {
        return res.status(404).send("Log file not found");
    }

    const content = fs.readFileSync(filePath, "utf-8");
    res.type("text/plain").send(content);
});

router.get("/logs/:filename", (req, res) => {
    const file = req.params.filename;
    const filePath = getLogFilePath(file);

    if (!filePath) {
        return res.status(404).send("Log file not found");
    }

    const { entries, summary } = parseLogFile(filePath);
    const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(2);

    res.render("log-viewer", {
        basePath: VIEW_BASE_PATH,
        filename: file,
        entries,
        summary,
        sizeKB,
    });
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
