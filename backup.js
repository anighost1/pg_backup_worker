import { exec } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import logger from "./config/logger.js";

dotenv.config();

const {
    PG_HOST,
    PG_PORT = 5432,
    PG_USER,
    PG_PASSWORD,
    BACKUP_DIR = "./backups",
} = process.env;

if (!PG_HOST || !PG_USER || !PG_PASSWORD) {
    logger.error({
        event: "startup_error",
        message: "Missing required env variables",
    });
    process.exit(1);
}

const env = {
    ...process.env,
    PGPASSWORD: PG_PASSWORD,
};

const backupRoot = path.resolve(BACKUP_DIR);
fs.mkdirSync(backupRoot, { recursive: true });

const listDbCommand = `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -At -c "SELECT datname FROM pg_database WHERE datistemplate = false;"`;

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
        .map(db => db.trim())
        .filter(Boolean);

    logger.info({
        event: "list_databases_success",
        count: databases.length,
    });

    backupDatabasesSequentially(databases);
});

function backupDatabasesSequentially(databases) {
    const db = databases.shift();
    if (!db) {
        logger.info({ event: "backup_all_complete" });
        return;
    }

    const startTime = Date.now();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const currentDate = new Date().toISOString().split("T")[0];

    const dbDir = path.join(backupRoot, currentDate, db);
    fs.mkdirSync(dbDir, { recursive: true });

    const filePath = path.join(dbDir, `${db}-${timestamp}.dump`);

    const dumpCommand = `pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -F c -b -v -f "${filePath}" ${db}`;

    logger.info({
        event: "backup_start",
        database: db,
    });

    exec(dumpCommand, { env }, (err) => {
        const durationMs = Date.now() - startTime;

        if (err) {
            logger.error({
                event: "backup_failed",
                database: db,
                duration_ms: durationMs,
                error: err.message,
            });
        } else {
            const stats = fs.statSync(filePath);
            const fileSizeBytes = stats.size;
            const fileSizeMB = +(fileSizeBytes / 1024 / 1024).toFixed(2);

            logger.info({
                event: "backup_success",
                database: db,
                file: filePath,
                duration_ms: durationMs,
                file_size_bytes: fileSizeBytes,
                file_size_mb: fileSizeMB,
            });
        }

        backupDatabasesSequentially(databases);
    });
}
