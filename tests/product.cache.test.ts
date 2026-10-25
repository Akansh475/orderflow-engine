import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";
import { redis } from "../src/config/redis.js";
import { productCache } from "../src/modules/products/product.cache.js";
import { productRepository } from "../src/modules/products/product.repository.js";

const prisma = new PrismaClient();

describe("Product Caching & Redis Integration", () => {
  const testPrefix = `cache-test-${Date.now()}`;
  let testProductId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await productCache.invalidatePattern("products:*");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await productCache.invalidatePattern("products:*");
    await prisma.product.deleteMany({
      where: { name: { startsWith: testPrefix } },
    });
    await prisma.$disconnect();
  });

  describe("GET /products/:id (Cache-Aside)", () => {
    it("should fetch from DB on cache miss, populate Redis, and serve from cache on subsequent call", async () => {
      const created = await prisma.product.create({
        data: {
          name: `${testPrefix}-Item-A`,
          price: 199.99,
          description: "Cache test description",
        },
      });
      testProductId = created.id;

      const cacheKey = productCache.getProductDetailKey(testProductId);

      // Verify cache miss initially
      const cachedBefore = await redis.get(cacheKey);
      expect(cachedBefore).toBeNull();

      const dbSpy = vi.spyOn(productRepository, "findById");

      // First request: Cache Miss
      const response1 = await request(app).get(`/products/${testProductId}`);
      expect(response1.status).toBe(200);
      expect(response1.body.data.id).toBe(testProductId);
      expect(response1.body.data.name).toBe(`${testPrefix}-Item-A`);
      expect(dbSpy).toHaveBeenCalledTimes(1);

      // Verify key exists in Redis with positive TTL
      const cachedAfter = await redis.get(cacheKey);
      expect(cachedAfter).not.toBeNull();
      const ttl = await redis.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      // Second request: Cache Hit (DB should not be queried again)
      const response2 = await request(app).get(`/products/${testProductId}`);
      expect(response2.status).toBe(200);
      expect(response2.body.data.id).toBe(testProductId);
      expect(dbSpy).toHaveBeenCalledTimes(1); // Call count remains 1
      expect(response2.body).toEqual(response1.body);
    });

    it("should return 404 and never cache nonexistent products", async () => {
      const nonExistentId = "non-existent-product-id-99999";
      const cacheKey = productCache.getProductDetailKey(nonExistentId);

      const response = await request(app).get(`/products/${nonExistentId}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");

      const cachedValue = await redis.get(cacheKey);
      expect(cachedValue).toBeNull();
    });
  });

  describe("GET /products (List Caching & Normalization)", () => {
    it("should cache list responses on miss and serve from cache on hit", async () => {
      const dbSpy = vi.spyOn(productRepository, "findPaginatedWithCount");

      // Request 1: Cache Miss
      const response1 = await request(app)
        .get("/products")
        .query({ search: testPrefix, page: 1, limit: 10 });

      expect(response1.status).toBe(200);
      expect(dbSpy).toHaveBeenCalledTimes(1);

      // Request 2: Cache Hit
      const response2 = await request(app)
        .get("/products")
        .query({ search: testPrefix, page: 1, limit: 10 });

      expect(response2.status).toBe(200);
      expect(dbSpy).toHaveBeenCalledTimes(1);
      expect(response2.body).toEqual(response1.body);
    });

    it("should generate deterministic cache keys regardless of query parameter order", async () => {
      const dbSpy = vi.spyOn(productRepository, "findPaginatedWithCount");

      // Request with page first, then limit
      const response1 = await request(app)
        .get("/products")
        .query({ page: 1, limit: 5, search: testPrefix, sortBy: "price", order: "asc" });

      expect(response1.status).toBe(200);
      expect(dbSpy).toHaveBeenCalledTimes(1);

      // Request with different query param order and whitespace/casing in search
      const response2 = await request(app)
        .get("/products")
        .query({ order: "asc", sortBy: "price", limit: 5, search: `  ${testPrefix.toUpperCase()}  `, page: 1 });

      expect(response2.status).toBe(200);
      expect(dbSpy).toHaveBeenCalledTimes(1); // Served from cache!
      expect(response2.body).toEqual(response1.body);
    });

    it("should maintain distinct cache keys for different query parameters", async () => {
      const dbSpy = vi.spyOn(productRepository, "findPaginatedWithCount");

      await request(app)
        .get("/products")
        .query({ search: testPrefix, page: 1, limit: 5 });

      await request(app)
        .get("/products")
        .query({ search: testPrefix, page: 2, limit: 5 });

      await request(app)
        .get("/products")
        .query({ search: testPrefix, sortBy: "name", order: "asc" });

      // All 3 have different parameters, so all 3 must query DB
      expect(dbSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("Cache Invalidation on Product Creation", () => {
    it("should invalidate all list cache entries when a new product is created", async () => {
      // 1. Populate list cache
      const listRes1 = await request(app)
        .get("/products")
        .query({ search: testPrefix });

      expect(listRes1.status).toBe(200);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      const cachedBeforeCreate = await redis.get(listKey);
      expect(cachedBeforeCreate).not.toBeNull();

      // 2. Create a new product
      const createRes = await request(app).post("/products").send({
        name: `${testPrefix}-Item-New`,
        price: 88.5,
        description: "Invalidation test item",
      });
      expect(createRes.status).toBe(201);

      // 3. Verify list cache entry has been invalidated
      const cachedAfterCreate = await redis.get(listKey);
      expect(cachedAfterCreate).toBeNull();

      // 4. Query again: should fetch fresh data from DB containing the new product
      const listRes2 = await request(app)
        .get("/products")
        .query({ search: testPrefix });

      expect(listRes2.status).toBe(200);
      const found = listRes2.body.data.some(
        (p: { name: string }) => p.name === `${testPrefix}-Item-New`,
      );
      expect(found).toBe(true);
    });
  });

  describe("Redis Failure Fallback (Graceful Degradation)", () => {
    it("should fall back to primary database if Redis GET fails", async () => {
      const getSpy = vi
        .spyOn(redis, "get")
        .mockRejectedValueOnce(new Error("Redis connection refused"));

      const response = await request(app).get(`/products/${testProductId}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(testProductId);
      expect(getSpy).toHaveBeenCalled();
    });

    it("should succeed and return product even if Redis SET fails", async () => {
      const setSpy = vi
        .spyOn(redis, "set")
        .mockRejectedValueOnce(new Error("Redis write failure"));

      const response = await request(app).get(`/products/${testProductId}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(testProductId);
      expect(setSpy).toHaveBeenCalled();
    });

    it("should succeed and create product even if Redis cache invalidation fails", async () => {
      const scanSpy = vi
        .spyOn(redis, "scan")
        .mockRejectedValueOnce(new Error("Redis SCAN failure"));

      const createRes = await request(app).post("/products").send({
        name: `${testPrefix}-Resilience-Item`,
        price: 49.99,
        description: "Created despite Redis failure",
      });

      expect(createRes.status).toBe(201);
      expect(createRes.body.data.name).toBe(`${testPrefix}-Resilience-Item`);
      expect(scanSpy).toHaveBeenCalled();
    });
  });
});
