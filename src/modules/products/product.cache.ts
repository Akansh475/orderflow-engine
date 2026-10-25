import { redis } from "../../config/redis.js";
import { logger } from "../../config/logger.js";
import type { ProductQueryParams } from "./product.validation.js";

export const DEFAULT_PRODUCT_CACHE_TTL_SECONDS = 60;

export function getProductCacheTtl(): number {
  const envVal = process.env.PRODUCT_CACHE_TTL_SECONDS;
  if (!envVal) return DEFAULT_PRODUCT_CACHE_TTL_SECONDS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PRODUCT_CACHE_TTL_SECONDS;
}

export function getProductDetailKey(id: string): string {
  return `products:detail:${id}`;
}

export function getProductListKey(params: ProductQueryParams): string {
  const page = Math.max(1, Math.floor(params.page || 1));
  const limit = Math.max(1, Math.floor(params.limit || 10));
  const sortBy = params.sortBy ?? "createdAt";
  const order = params.order ?? "desc";
  const search = params.search ? params.search.trim().toLowerCase() : "";

  return `products:list:limit=${limit}:order=${order}:page=${page}:search=${encodeURIComponent(search)}:sortBy=${sortBy}`;
}

export const productCache = {
  getProductDetailKey,
  getProductListKey,
  getProductCacheTtl,

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);
      if (raw === null || raw === undefined) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.warn(
        { key, err: error },
        "Redis GET failed; falling back to primary database",
      );
      return null;
    }
  },

  async set(
    key: string,
    value: unknown,
    ttlSeconds: number = getProductCacheTtl(),
  ): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redis.set(key, serialized, "EX", ttlSeconds);
    } catch (error) {
      logger.warn({ key, err: error }, "Redis SET failed; skipping cache update");
    }
  },

  async del(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ key, err: error }, "Redis DEL failed");
    }
  },

  async invalidatePattern(pattern: string): Promise<number> {
    try {
      let cursor = "0";
      let totalDeleted = 0;

      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100,
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          const count = await redis.unlink(...keys);
          totalDeleted += count;
        }
      } while (cursor !== "0");

      return totalDeleted;
    } catch (error) {
      logger.warn({ pattern, err: error }, "Redis scan invalidation failed");
      return 0;
    }
  },

  async invalidateProductLists(): Promise<number> {
    return this.invalidatePattern("products:list:*");
  },

  async invalidateProductDetail(id: string): Promise<void> {
    await this.del(this.getProductDetailKey(id));
  },
};
