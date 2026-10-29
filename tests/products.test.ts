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

describe("PATCH /products/:id", () => {
  const patchPrefix = `patch-prod-${Date.now()}`;
  let productId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: `${patchPrefix}-Initial Product`,
        description: "Initial description",
        price: 99.99,
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { name: { startsWith: patchPrefix } },
    });
  });

  it("should successfully update product name and price with PATCH", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({
        name: `${patchPrefix}-Updated Product`,
        price: 149.5,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(productId);
    expect(response.body.data.name).toBe(`${patchPrefix}-Updated Product`);
    expect(Number(response.body.data.price)).toBe(149.5);
    expect(response.body.data.description).toBe("Initial description");

    const inDb = await prisma.product.findUnique({ where: { id: productId } });
    expect(inDb?.name).toBe(`${patchPrefix}-Updated Product`);
    expect(Number(inDb?.price)).toBe(149.5);
  });

  it("should preserve omitted fields on partial update", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({
        description: "Updated description only",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe("Updated description only");
    expect(response.body.data.name).toBe(`${patchPrefix}-Updated Product`);
    expect(Number(response.body.data.price)).toBe(149.5);
  });

  it("should allow clearing optional description by passing null", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({
        description: null,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBeNull();
  });

  it("should reject empty update body with HTTP 400", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should reject negative or zero price with HTTP 400", async () => {
    for (const invalidPrice of [-10, 0]) {
      const response = await request(app)
        .patch(`/products/${productId}`)
        .send({ price: invalidPrice });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("should reject empty name string with HTTP 400", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({ name: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should reject attempts to update immutable or unrecognized fields", async () => {
    const response = await request(app)
      .patch(`/products/${productId}`)
      .send({
        id: "cannot-change-id",
        name: "Valid Name",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 404 for updating a nonexistent product", async () => {
    const response = await request(app)
      .patch("/products/nonexistent-product-id-99999")
      .send({ name: "Does Not Exist" });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("PUT /products/:id (Replacement Semantics)", () => {
  const putPrefix = `put-prod-${Date.now()}`;
  let productId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: `${putPrefix}-To Replace`,
        description: "Old description to be replaced",
        price: 50.0,
      },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { name: { startsWith: putPrefix } },
    });
  });

  it("should replace product fields and reset omitted description to null", async () => {
    const response = await request(app)
      .put(`/products/${productId}`)
      .send({
        name: `${putPrefix}-Replaced`,
        price: 75.0,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe(`${putPrefix}-Replaced`);
    expect(Number(response.body.data.price)).toBe(75.0);
    expect(response.body.data.description).toBeNull();
  });

  it("should reject PUT when required fields are missing", async () => {
    const response = await request(app)
      .put(`/products/${productId}`)
      .send({
        name: `${putPrefix}-Missing-Price`,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 404 when replacing a nonexistent product", async () => {
    const response = await request(app)
      .put("/products/nonexistent-id-88888")
      .send({
        name: "Nonexistent Product",
        price: 10.0,
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("DELETE /products/:id", () => {
  const delPrefix = `del-prod-${Date.now()}`;

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { name: { startsWith: delPrefix } },
    });
  });

  it("should successfully delete a product with no existing relationships", async () => {
    const product = await prisma.product.create({
      data: {
        name: `${delPrefix}-Standalone Item`,
        price: 25.0,
      },
    });

    const response = await request(app).delete(`/products/${product.id}`);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Product deleted successfully");

    const foundInDb = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(foundInDb).toBeNull();
  });

  it("should return 404 when deleting a nonexistent product", async () => {
    const response = await request(app).delete("/products/nonexistent-product-00000");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("should block deletion with 409 when product has an associated inventory record", async () => {
    const product = await prisma.product.create({
      data: {
        name: `${delPrefix}-With-Inventory`,
        price: 39.99,
      },
    });

    const inventory = await prisma.inventory.create({
      data: {
        productId: product.id,
        available: 10,
        reserved: 0,
      },
    });

    const response = await request(app).delete(`/products/${product.id}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION");

    const stillExists = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(stillExists).not.toBeNull();

    // Clean up inventory and then product
    await prisma.inventory.delete({ where: { id: inventory.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it("should block deletion with 409 when product is referenced in order items", async () => {
    const product = await prisma.product.create({
      data: {
        name: `${delPrefix}-With-Order`,
        price: 60.0,
      },
    });

    const order = await prisma.order.create({
      data: {
        customerId: "cust-test-delete-ref",
        total: 60.0,
        items: {
          create: {
            productId: product.id,
            quantity: 1,
            unitPrice: 60.0,
          },
        },
      },
    });

    const response = await request(app).delete(`/products/${product.id}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION");

    const stillExists = await prisma.product.findUnique({
      where: { id: product.id },
    });
    expect(stillExists).not.toBeNull();

    // Clean up order item, order, and product safely
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });
});
