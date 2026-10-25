import { Redis } from "ioredis";
import { logger } from "./logger.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const redis = new Redis(redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  lazyConnect: false,
});

redis.on("error", (error) => {
  logger.warn({ err: error }, "Redis client connection error");
});

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch (error) {
    logger.warn({ err: error }, "Error while disconnecting Redis client");
    redis.disconnect();
  }
}
