import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "NOTION_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "*.token",
      "*.secret",
      "*.authorization",
      "headers.authorization",
      "headers.Authorization",
    ],
    remove: true,
  },
});
