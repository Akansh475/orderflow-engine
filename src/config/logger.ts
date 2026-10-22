
import pino from "pino";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "orderflow-engine",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "token",
    ],
    censor: "[REDACTED]",
  },
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incomingId = req.headers["x-request-id"];
    const requestId =
      typeof incomingId === "string" && incomingId.length <= 128
        ? incomingId
        : randomUUID();

    res.setHeader("X-Request-Id", requestId);
    return requestId;
  },
  customLogLevel(_req, res, error) {
    if (error || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customAttributeKeys: {
    reqId: "requestId",
  },
});
