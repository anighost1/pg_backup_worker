import fs from "fs";
import path from "path";
import { createLogger, format, transports } from "winston";
import "winston-daily-rotate-file";

const logDir = path.join(process.cwd(), "logs");

const currentDate = new Date().toISOString().split("T")[0];

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const logger = createLogger({
    level: "info",
    format: format.combine(
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.printf(
            ({ timestamp, level, message }) =>
                `${timestamp} [${level.toUpperCase()}] ${message}`
        )
    ),
    transports: [
        new transports.Console(),

        new transports.DailyRotateFile({
            filename: path.join(logDir, currentDate, "pg-backup-%DATE%.log"),
            datePattern: "YYYY-MM-DD",
            zippedArchive: true,
            maxSize: "20m",
            maxFiles: "14d",
        }),

        new transports.DailyRotateFile({
            filename: path.join(logDir, currentDate, "pg-backup-error-%DATE%.log"),
            level: "error",
            datePattern: "YYYY-MM-DD",
            zippedArchive: true,
            maxFiles: "30d",
        }),
    ],
});

export default logger;
