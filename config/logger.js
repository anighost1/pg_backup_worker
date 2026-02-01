import fs from "fs";
import path from "path";
import { createLogger, format, transports } from "winston";
import "winston-daily-rotate-file";
import dotenv from "dotenv";
dotenv.config();

const logDir = path.join(process.cwd(), "logs");
fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
    level: "info",
    format: format.combine(
        format.timestamp(),
        format.json()
    ),
    defaultMeta: {
        service: "pg-backup-worker",
        env: process.env.NODE_ENV || "development",
    },
    transports: [
        new transports.DailyRotateFile({
            filename: path.join(logDir, "pg-backup-%DATE%.json"),
            datePattern: "YYYY-MM-DD",
            zippedArchive: true,
            maxFiles: "14d",
        }),
    ],
});

export default logger;
