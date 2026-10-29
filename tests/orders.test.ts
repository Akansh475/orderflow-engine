
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";

const prisma = new PrismaClient();

describe("Orders API", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should create an order and calculate its total from product prices", async () => {
    const product = await prisma.product.create({
      data: {
        name: "Test Mouse",
        price: 799,
        inventory: {
          create: {
            available: 10,
            reserved: 0,
          },
        },
      },
    });

    const response = await request(app)
      .post("/orders")
      .send({
        customerId: "customer-test-001",
        idempotencyKey: `test-order-${Date.now()}`,
        items: [
          {
            productId: product.id,
            quantity: 2,
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.customerId).toBe("customer-test-001");
    expect(response.body.data.total).toBe("1598");
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].quantity).toBe(2);

    const inventory = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });

    expect(inventory?.available).toBe(8);
    expect(inventory?.reserved).toBe(2);
  });

  it("should prevent overselling when two orders compete for the last item", async () => {
    const product = await prisma.product.create({
      data: {
        name: `Concurrency Test ${Date.now()}`,
        price: 100,
        inventory: {
          create: {
            available: 1,
            reserved: 0,
          },
        },
      },
    });

    const createOrder = (customerId: string) =>
      request(app).post("/orders").send({
        customerId,
        idempotencyKey: `concurrency-${customerId}-${Date.now()}`,
        items: [{ productId: product.id, quantity: 1 }],
      });

    const responses = await Promise.all([
      createOrder("concurrency-customer-A"),
      createOrder("concurrency-customer-B"),
    ]);

    const successfulOrders = responses.filter(
      (response) => response.status === 201,
    );
    const rejectedOrders = responses.filter(
      (response) => response.status >= 400,
    );

    expect(successfulOrders).toHaveLength(1);
    expect(rejectedOrders).toHaveLength(1);

    const inventory = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });

    expect(inventory?.available).toBe(0);
    expect(inventory?.reserved).toBe(1);
  });

  describe("GET /orders", () => {
    const custPrefix = `cust-list-${Date.now()}`;
    let productA: { id: string };
    let productB: { id: string };

    beforeAll(async () => {
      productA = await prisma.product.create({
        data: {
          name: `Order Test Prod A ${Date.now()}`,
          price: 100,
        },
      });
      productB = await prisma.product.create({
        data: {
          name: `Order Test Prod B ${Date.now()}`,
          price: 250,
        },
      });

      await prisma.order.create({
        data: {
          customerId: `${custPrefix}-1`,
          status: "PENDING",
          total: 100,
          items: {
            create: [{ productId: productA.id, quantity: 1, unitPrice: 100 }],
          },
        },
      });

      await prisma.order.create({
        data: {
          customerId: `${custPrefix}-1`,
          status: "CONFIRMED",
          total: 500,
          items: {
            create: [{ productId: productB.id, quantity: 2, unitPrice: 250 }],
          },
        },
      });

      await prisma.order.create({
        data: {
          customerId: `${custPrefix}-2`,
          status: "PENDING",
          total: 350,
          items: {
            create: [
              { productId: productA.id, quantity: 1, unitPrice: 100 },
              { productId: productB.id, quantity: 1, unitPrice: 250 },
            ],
          },
        },
      });
    });

    afterAll(async () => {
      await prisma.orderItem.deleteMany({
        where: {
          order: { customerId: { startsWith: custPrefix } },
        },
      });
      await prisma.order.deleteMany({
        where: { customerId: { startsWith: custPrefix } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: [productA.id, productB.id] } },
      });
    });

    it("should return orders with default pagination and include order items", async () => {
      const response = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1` });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });

      const firstOrder = response.body.data[0];
      expect(firstOrder.items).toBeDefined();
      expect(Array.isArray(firstOrder.items)).toBe(true);
      expect(firstOrder.items.length).toBeGreaterThan(0);
      expect(firstOrder.statusHistory).toBeUndefined();
      expect(firstOrder.payments).toBeUndefined();
    });

    it("should support custom pagination limit and page offset", async () => {
      const response = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, limit: 1, page: 2 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });

    it("should filter orders by status", async () => {
      const response = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, status: "CONFIRMED" });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe("CONFIRMED");
      expect(response.body.pagination.total).toBe(1);
    });

    it("should filter orders by customerId with trimming", async () => {
      const response = await request(app)
        .get("/orders")
        .query({ customerId: `  ${custPrefix}-2  ` });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].customerId).toBe(`${custPrefix}-2`);
    });

    it("should sort orders by total ascending and descending", async () => {
      const ascResponse = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, sortBy: "total", order: "asc" });

      expect(ascResponse.status).toBe(200);
      expect(Number(ascResponse.body.data[0].total)).toBe(100);
      expect(Number(ascResponse.body.data[1].total)).toBe(500);

      const descResponse = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, sortBy: "total", order: "desc" });

      expect(descResponse.status).toBe(200);
      expect(Number(descResponse.body.data[0].total)).toBe(500);
      expect(Number(descResponse.body.data[1].total)).toBe(100);
    });

    it("should sort orders by createdAt and updatedAt", async () => {
      const createdResponse = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, sortBy: "createdAt", order: "asc" });

      expect(createdResponse.status).toBe(200);
      expect(createdResponse.body.data).toHaveLength(2);

      const updatedResponse = await request(app)
        .get("/orders")
        .query({ customerId: `${custPrefix}-1`, sortBy: "updatedAt", order: "desc" });

      expect(updatedResponse.status).toBe(200);
      expect(updatedResponse.body.data).toHaveLength(2);
    });

    it("should return empty results with totalPages 0 when no orders match", async () => {
      const response = await request(app)
        .get("/orders")
        .query({ customerId: "non-existent-cust-999" });

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

    it("should reject invalid order query parameters with HTTP 400", async () => {
      const testCases = [
        { query: { page: 0 }, field: "page" },
        { query: { page: -2 }, field: "page" },
        { query: { page: "not-a-number" }, field: "page" },
        { query: { limit: 0 }, field: "limit" },
        { query: { limit: 101 }, field: "limit" },
        { query: { status: "INVALID_STATUS" }, field: "status" },
        { query: { customerId: "" }, field: "customerId" },
        { query: { customerId: "   " }, field: "customerId" },
        { query: { sortBy: "name" }, field: "sortBy" },
        { query: { order: "down" }, field: "order" },
      ];

      for (const { query, field } of testCases) {
        const response = await request(app).get("/orders").query(query);
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

  describe("Product Archival & Order Safety", () => {
    it("should reject order creation when an item is an archived product", async () => {
      const archivedProduct = await prisma.product.create({
        data: {
          name: `Archived Order Item ${Date.now()}`,
          price: 50.0,
          isArchived: true,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const response = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-archived-order",
          items: [{ productId: archivedProduct.id, quantity: 1 }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("PRODUCT_ARCHIVED");

      const inv = await prisma.inventory.findUnique({
        where: { productId: archivedProduct.id },
      });
      expect(inv?.available).toBe(10);
      expect(inv?.reserved).toBe(0);
    });

    it("should reject mixed orders and leave zero partial inventory reservations", async () => {
      const activeProduct = await prisma.product.create({
        data: {
          name: `Active Mixed Item ${Date.now()}`,
          price: 100.0,
          isArchived: false,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const archivedProduct = await prisma.product.create({
        data: {
          name: `Archived Mixed Item ${Date.now()}`,
          price: 150.0,
          isArchived: true,
          inventory: {
            create: {
              available: 5,
              reserved: 0,
            },
          },
        },
      });

      const response = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-mixed-order",
          items: [
            { productId: activeProduct.id, quantity: 3 },
            { productId: archivedProduct.id, quantity: 1 },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("PRODUCT_ARCHIVED");

      // Verify active product stock was NOT partially reserved
      const activeInv = await prisma.inventory.findUnique({
        where: { productId: activeProduct.id },
      });
      expect(activeInv?.available).toBe(10);
      expect(activeInv?.reserved).toBe(0);

      // Verify archived product stock was NOT reserved
      const archivedInv = await prisma.inventory.findUnique({
        where: { productId: archivedProduct.id },
      });
      expect(archivedInv?.available).toBe(5);
      expect(archivedInv?.reserved).toBe(0);
    });

    it("should preserve historical orders when a product is subsequently archived", async () => {
      const product = await prisma.product.create({
        data: {
          name: `Historical Product ${Date.now()}`,
          price: 200.0,
          isArchived: false,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const orderRes = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-history-check",
          items: [{ productId: product.id, quantity: 2 }],
        });

      expect(orderRes.status).toBe(201);
      const orderId = orderRes.body.data.id;

      // Archive the product after order placement
      const archiveRes = await request(app).patch(
        `/products/${product.id}/archive`,
      );
      expect(archiveRes.status).toBe(200);

      // Verify order and its line items remain intact and readable
      const orderCheck = await request(app).get(`/orders/${orderId}`);
      expect(orderCheck.status).toBe(200);
      expect(orderCheck.body.data.id).toBe(orderId);
      expect(orderCheck.body.data.items).toHaveLength(1);
      expect(orderCheck.body.data.items[0].productId).toBe(product.id);
    });

    it("should allow restored products to be ordered while respecting inventory constraints", async () => {
      const product = await prisma.product.create({
        data: {
          name: `Restore Order Test ${Date.now()}`,
          price: 75.0,
          isArchived: true,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      // 1. Confirm ordering fails while archived
      const failedOrder = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-restore-test",
          items: [{ productId: product.id, quantity: 4 }],
        });
      expect(failedOrder.status).toBe(400);
      expect(failedOrder.body.error.code).toBe("PRODUCT_ARCHIVED");

      // 2. Restore product
      const unarchiveRes = await request(app).patch(
        `/products/${product.id}/unarchive`,
      );
      expect(unarchiveRes.status).toBe(200);
      expect(unarchiveRes.body.data.isArchived).toBe(false);

      // 3. Place order with restored product (quantity: 4)
      const successOrder = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-restore-test",
          items: [{ productId: product.id, quantity: 4 }],
        });

      expect(successOrder.status).toBe(201);
      expect(successOrder.body.data.items).toHaveLength(1);
      expect(successOrder.body.data.items[0].quantity).toBe(4);

      const invAfterSuccess = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invAfterSuccess?.available).toBe(6);
      expect(invAfterSuccess?.reserved).toBe(4);

      // 4. Test insufficient inventory on restored product (request 10 when 6 available)
      const insufficientOrder = await request(app)
        .post("/orders")
        .send({
          customerId: "cust-restore-test-2",
          items: [{ productId: product.id, quantity: 10 }],
        });

      expect(insufficientOrder.status).toBe(409);
      expect(insufficientOrder.body.error.code).toBe("INSUFFICIENT_INVENTORY");

      const invAfterReject = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invAfterReject?.available).toBe(6);
      expect(invAfterReject?.reserved).toBe(4);
    });
  });

});
