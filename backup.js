import { exec } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import logger from "./config/logger.js";

dotenv.config();

/* =====================================================
   ENV
===================================================== */
const {
    PG_HOST,
    PG_PORT = 5432,
    PG_USER,
    PG_PASSWORD,
    BACKUP_DIR = "./backups",
    BACKUP_RETENTION_DAYS = 7,
} = process.env;

if (!PG_HOST || !PG_USER || !PG_PASSWORD) {
    logger.error({
        event: "startup_error",
        message: "Missing required env variables",
    });
    process.exit(1);
}

/* =====================================================
   LOCK FILE (PREVENT DOUBLE RUNS)
===================================================== */
const LOCK_FILE = path.join(process.cwd(), ".backup.lock");

if (fs.existsSync(LOCK_FILE)) {
    logger.warn({
        event: "backup_already_running",
        message: "Lock file exists. Exiting.",
    });
    process.exit(0);
}

fs.writeFileSync(LOCK_FILE, String(process.pid));

const cleanupLock = () => {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
};

process.on("exit", cleanupLock);
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

/* =====================================================
   POSTGRES ENV
===================================================== */
const env = {
    ...process.env,
    PGPASSWORD: PG_PASSWORD,
};

/* =====================================================
   BACKUP ROOT
===================================================== */
const backupRoot = path.resolve(BACKUP_DIR);
fs.mkdirSync(backupRoot, { recursive: true });

/* =====================================================
   RETENTION CLEANUP (OLDER THAN N DAYS)
===================================================== */
function cleanupOldBackups() {
    if (!fs.existsSync(backupRoot)) return;

    const now = Date.now();
    const maxAgeMs = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    fs.readdirSync(backupRoot).forEach((dateDir) => {
        const fullPath = path.join(backupRoot, dateDir);
        if (!fs.statSync(fullPath).isDirectory()) return;

        const dirTime = new Date(dateDir).getTime();
        if (isNaN(dirTime)) return;

        if (now - dirTime > maxAgeMs) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            logger.info({
                event: "backup_retention_cleanup",
                deleted: dateDir,
            });
        }
    });
}

/* =====================================================
   LIST DATABASES (EXCLUDE SYSTEM DBS)
===================================================== */
const listDbCommand = `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -At -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres');"`;

logger.info({ event: "list_databases_start" });

exec(listDbCommand, { env }, (err, stdout) => {
    if (err) {
        logger.error({
            event: "list_databases_failed",
            error: err.message,
        });
        process.exit(1);
    }

    const databases = stdout
        .split("\n")
        .map((db) => db.trim())
        .filter(Boolean);

    logger.info({
        event: "list_databases_success",
        count: databases.length,
    });

    cleanupOldBackups();
    backupDatabasesSequentially(databases);
});

/* =====================================================
   BACKUP DATABASES SEQUENTIALLY
===================================================== */
function backupDatabasesSequentially(databases) {
    const dbName = databases.shift();
    if (!dbName) {
        logger.info({ event: "backup_all_complete" });
        return;
    }

    const startTime = Date.now();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const currentDate = new Date().toISOString().split("T")[0];

    const dbDir = path.join(backupRoot, currentDate, dbName);
    fs.mkdirSync(dbDir, { recursive: true });

    const backupFile = `${dbName}-${timestamp}.dump`;
    const filePath = path.join(dbDir, backupFile);

    const dumpCommand = `pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -F c -b -f "${filePath}" ${dbName}`;

    logger.info({
        event: "backup_start",
        database: dbName,
    });

    exec(dumpCommand, { env }, (err) => {
        const durationMs = Date.now() - startTime;

        if (err) {
            logger.error({
                event: "backup_failed",
                database: dbName,
                error: err.message,
                durationMs,
                time: new Date().toISOString(),
            });
        } else {
            const { size } = fs.statSync(filePath);
            const sizeMB = +(size / 1024 / 1024).toFixed(2);

            logger.info({
                event: "backup_success",
                database: dbName,
                file: backupFile,
                sizeMB,
                durationMs,
                time: new Date().toISOString(),
            });
        }

        backupDatabasesSequentially(databases);
    });
}
