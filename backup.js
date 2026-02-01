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
    logger.error("Missing required env variables");
    process.exit(1);
}

const env = {
    ...process.env,
    PGPASSWORD: PG_PASSWORD,
};

const backupRoot = path.resolve(BACKUP_DIR);
fs.mkdirSync(backupRoot, { recursive: true });

const listDbCommand = `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -At -c "SELECT datname FROM pg_database WHERE datistemplate = false;"`;

logger.info("Fetching database list...");

exec(listDbCommand, { env }, (err, stdout) => {
    if (err) {
        logger.error(`Failed to list databases: ${err.message}`);
        process.exit(1);
    }

    const databases = stdout
        .split("\n")
        .map(db => db.trim())
        .filter(Boolean);

    if (databases.length === 0) {
        logger.warn("No databases found");
        return;
    }

    logger.info(`Found ${databases.length} databases`);
    backupDatabasesSequentially(databases);
});

function backupDatabasesSequentially(databases) {
    const db = databases.shift();

    if (!db) {
        logger.info("All databases backed up successfully");
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const currentDate = new Date().toISOString().split("T")[0];

    const dbDir = path.join(backupRoot, currentDate, db);
    fs.mkdirSync(dbDir, { recursive: true });

    const filePath = path.join(dbDir, `${db}-${timestamp}.dump`);

    const dumpCommand = `pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -F c -b -v -f "${filePath}" ${db}`;

    logger.info(`Backing up database: ${db}`);

    exec(dumpCommand, { env }, (err) => {
        if (err) {
            logger.error(`Backup failed for ${db}: ${err.message}`);
        } else {
            logger.info(`Backup completed: ${db}`);
        }

        backupDatabasesSequentially(databases);
    });
}
