import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";

const prisma = new PrismaClient();

describe("POST /products", () => {
  it("should reject a product with an invalid price", async () => {
    const response = await request(app)
      .post("/products")
      .send({
        name: "Test Product",
        price: -10,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /products/:id", () => {
  it("should return a product by ID", async () => {
    const product = await prisma.product.create({
      data: {
        name: `Detail-Test-${Date.now()}`,
        price: 99.99,
      },
    });

    const response = await request(app).get(`/products/${product.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(product.id);
    expect(response.body.data.name).toBe(product.name);

    await prisma.product.delete({ where: { id: product.id } });
  });

  it("should return 404 for a non-existent product", async () => {
    const response = await request(app).get("/products/nonexistent-id-00000");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("GET /products", () => {
  const prefix = `test-prod-${Date.now()}`;

  beforeAll(async () => {
    await prisma.product.createMany({
      data: [
        { name: `${prefix}-Alpha Keyboard`, price: 150 },
        { name: `${prefix}-Beta Mouse`, price: 50 },
        { name: `${prefix}-Gamma Monitor`, price: 300 },
        { name: `${prefix}-Delta Mousepad`, price: 20 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { name: { startsWith: prefix } },
    });
    await prisma.$disconnect();
  });

  it("should return paginated products with default settings", async () => {
    const response = await request(app).get("/products");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.pagination).toBeDefined();
    expect(response.body.pagination.page).toBe(1);
    expect(response.body.pagination.limit).toBe(10);
    expect(response.body.pagination.total).toBeGreaterThanOrEqual(4);
    expect(response.body.pagination.totalPages).toBeGreaterThanOrEqual(1);
    expect(typeof response.body.pagination.hasNextPage).toBe("boolean");
    expect(response.body.pagination.hasPreviousPage).toBe(false);
  });

  it("should support custom page and limit with pagination metadata", async () => {
    const response = await request(app)
      .get("/products")
      .query({ search: prefix, limit: 2, page: 2 });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 4,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it("should filter products by search term case-insensitively and trimmed", async () => {
    const response = await request(app)
      .get("/products")
      .query({ search: `  ${prefix}-BETA  ` });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe(`${prefix}-Beta Mouse`);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.pagination.totalPages).toBe(1);
  });

  it("should sort products by price ascending and descending", async () => {
    const ascResponse = await request(app)
      .get("/products")
      .query({ search: prefix, sortBy: "price", order: "asc" });

    expect(ascResponse.status).toBe(200);
    expect(ascResponse.body.data).toHaveLength(4);
    expect(Number(ascResponse.body.data[0].price)).toBe(20);
    expect(Number(ascResponse.body.data[3].price)).toBe(300);

    const descResponse = await request(app)
      .get("/products")
      .query({ search: prefix, sortBy: "price", order: "desc" });

    expect(descResponse.status).toBe(200);
    expect(Number(descResponse.body.data[0].price)).toBe(300);
    expect(Number(descResponse.body.data[3].price)).toBe(20);
  });

  it("should sort products by name ascending", async () => {
    const response = await request(app)
      .get("/products")
      .query({ search: prefix, sortBy: "name", order: "asc" });

    expect(response.status).toBe(200);
    expect(response.body.data[0].name).toBe(`${prefix}-Alpha Keyboard`);
    expect(response.body.data[3].name).toBe(`${prefix}-Gamma Monitor`);
  });

  it("should return empty results with totalPages 0 for non-matching search", async () => {
    const response = await request(app)
      .get("/products")
      .query({ search: "non-existent-product-xyz-123456" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it("should reject invalid pagination and sorting query parameters with HTTP 400", async () => {
    const testCases = [
      { query: { page: 0 }, field: "page" },
      { query: { page: -1 }, field: "page" },
      { query: { page: "abc" }, field: "page" },
      { query: { limit: 0 }, field: "limit" },
      { query: { limit: 101 }, field: "limit" },
      { query: { limit: "invalid" }, field: "limit" },
      { query: { sortBy: "invalidField" }, field: "sortBy" },
      { query: { order: "up" }, field: "order" },
    ];

    for (const { query, field } of testCases) {
      const response = await request(app).get("/products").query(query);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(
        response.body.error.details.some((d: { field: string }) =>
          d.field.includes(field),
        ),
      ).toBe(true);
    }
  });
});
