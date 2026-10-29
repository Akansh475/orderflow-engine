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
    await prisma.inventory.deleteMany({
      where: { product: { name: { startsWith: testPrefix } } },
    });
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

  describe("Cache Invalidation on Product Mutation (Update & Delete)", () => {
    it("should invalidate both detail cache and all list caches when a product is updated via PATCH", async () => {
      // 1. Create product
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-To-Patch`,
          price: 55.0,
          description: "Original Description",
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      // 2. Populate detail cache and list cache
      const getDetailRes = await request(app).get(`/products/${product.id}`);
      expect(getDetailRes.status).toBe(200);

      const getListRes = await request(app)
        .get("/products")
        .query({ search: testPrefix });
      expect(getListRes.status).toBe(200);

      // Verify caches populated
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 3. Perform PATCH mutation
      const patchRes = await request(app)
        .patch(`/products/${product.id}`)
        .send({
          name: `${testPrefix}-Patched-Successfully`,
          price: 79.99,
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.name).toBe(`${testPrefix}-Patched-Successfully`);

      // 4. Verify detail and list caches were invalidated
      expect(await redis.get(detailKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();

      // 5. Subsequent GET fetches fresh updated data and repopulates cache
      const getFreshRes = await request(app).get(`/products/${product.id}`);
      expect(getFreshRes.status).toBe(200);
      expect(getFreshRes.body.data.name).toBe(`${testPrefix}-Patched-Successfully`);
      expect(Number(getFreshRes.body.data.price)).toBe(79.99);

      const repopulated = await redis.get(detailKey);
      expect(repopulated).not.toBeNull();
    });

    it("should invalidate both detail cache and all list caches when a product is deleted", async () => {
      // 1. Create product
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-To-Delete`,
          price: 40.0,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      // 2. Populate caches
      await request(app).get(`/products/${product.id}`);
      await request(app).get("/products").query({ search: testPrefix });

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 3. Delete product
      const deleteRes = await request(app).delete(`/products/${product.id}`);
      expect(deleteRes.status).toBe(200);

      // 4. Verify detail and list caches were invalidated
      expect(await redis.get(detailKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();

      // 5. Subsequent GET returns 404 and does not cache
      const freshGet = await request(app).get(`/products/${product.id}`);
      expect(freshGet.status).toBe(404);
      expect(await redis.get(detailKey)).toBeNull();
    });

    it("should NOT invalidate existing cache entries when PATCH update fails validation or product is not found", async () => {
      // 1. Create product and populate caches
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-Failed-Patch-Item`,
          price: 30.0,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      await request(app).get(`/products/${product.id}`);
      await request(app).get("/products").query({ search: testPrefix });

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 2. Attempt invalid PATCH (validation error 400)
      const invalidPatchRes = await request(app)
        .patch(`/products/${product.id}`)
        .send({ price: -50 });

      expect(invalidPatchRes.status).toBe(400);

      // 3. Verify caches remain INTACT
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 4. Attempt PATCH on nonexistent ID (404)
      const nonExistentPatchRes = await request(app)
        .patch("/products/nonexistent-cache-test-id")
        .send({ name: "New Name" });

      expect(nonExistentPatchRes.status).toBe(404);

      // 5. Verify caches for existing product remain INTACT
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();
    });

    it("should NOT invalidate existing cache entries when DELETE fails due to referential integrity restriction", async () => {
      // 1. Create product with inventory
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-Protected-Item`,
          price: 120.0,
        },
      });

      const inventory = await prisma.inventory.create({
        data: {
          productId: product.id,
          available: 5,
          reserved: 0,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      // 2. Populate caches
      await request(app).get(`/products/${product.id}`);
      await request(app).get("/products").query({ search: testPrefix });

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 3. Attempt DELETE which is blocked by referential integrity
      const deleteRes = await request(app).delete(`/products/${product.id}`);
      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.error.code).toBe(
        "PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION",
      );

      // 4. Verify caches were NOT invalidated
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // Clean up
      await prisma.inventory.delete({ where: { id: inventory.id } });
      await prisma.product.delete({ where: { id: product.id } });
    });

    it("should invalidate detail and list caches when a product is archived via PATCH /products/:id/archive", async () => {
      // 1. Create product
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-To-Archive-Cache`,
          price: 85.0,
          isArchived: false,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      // 2. Populate caches
      const detailRes = await request(app).get(`/products/${product.id}`);
      expect(detailRes.status).toBe(200);

      const listRes = await request(app)
        .get("/products")
        .query({ search: testPrefix });
      expect(listRes.status).toBe(200);

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 3. Archive product
      const archiveRes = await request(app).patch(
        `/products/${product.id}/archive`,
      );
      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.isArchived).toBe(true);

      // 4. Verify detail and list caches were invalidated
      expect(await redis.get(detailKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();

      // 5. Subsequent GET /products/:id returns 404 and does not cache
      const freshGet = await request(app).get(`/products/${product.id}`);
      expect(freshGet.status).toBe(404);
      expect(await redis.get(detailKey)).toBeNull();
    });

    it("should NOT invalidate existing cache entries when archival fails with 404", async () => {
      // 1. Create product and populate caches
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-Active-Safe-Cache`,
          price: 95.0,
          isArchived: false,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      await request(app).get(`/products/${product.id}`);
      await request(app).get("/products").query({ search: testPrefix });

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 2. Attempt archive on nonexistent ID
      const failedArchiveRes = await request(app).patch(
        "/products/nonexistent-archive-cache-id/archive",
      );
      expect(failedArchiveRes.status).toBe(404);

      // 3. Verify caches for existing active product remain intact
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();
    });

    it("should invalidate detail and list caches when a product is restored via PATCH /products/:id/unarchive", async () => {
      // 1. Create archived product
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-To-Unarchive-Cache`,
          price: 110.0,
          isArchived: true,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      // 2. Populate list cache (will not include the archived product)
      const listRes1 = await request(app)
        .get("/products")
        .query({ search: testPrefix });
      expect(listRes1.status).toBe(200);
      expect(await redis.get(listKey)).not.toBeNull();

      // 3. Restore product
      const unarchiveRes = await request(app).patch(
        `/products/${product.id}/unarchive`,
      );
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.data.isArchived).toBe(false);

      // 4. Verify detail and list caches were invalidated
      expect(await redis.get(detailKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();

      // 5. Subsequent GET /products/:id returns 200 and caches the restored product
      const freshGet = await request(app).get(`/products/${product.id}`);
      expect(freshGet.status).toBe(200);
      expect(freshGet.body.data.isArchived).toBe(false);
      expect(await redis.get(detailKey)).not.toBeNull();
    });

    it("should NOT invalidate existing cache entries when restore fails with 404", async () => {
      // 1. Create product and populate caches
      const product = await prisma.product.create({
        data: {
          name: `${testPrefix}-Active-Safe-Restore-Cache`,
          price: 99.0,
          isArchived: false,
        },
      });

      const detailKey = productCache.getProductDetailKey(product.id);
      const listKey = productCache.getProductListKey({
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        order: "desc",
        search: testPrefix,
      });

      await request(app).get(`/products/${product.id}`);
      await request(app).get("/products").query({ search: testPrefix });

      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();

      // 2. Attempt restore on nonexistent ID
      const failedRestoreRes = await request(app).patch(
        "/products/nonexistent-unarchive-cache-id/unarchive",
      );
      expect(failedRestoreRes.status).toBe(404);

      // 3. Verify caches for existing active product remain intact
      expect(await redis.get(detailKey)).not.toBeNull();
      expect(await redis.get(listKey)).not.toBeNull();
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
