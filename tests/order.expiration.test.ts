import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";
import { orderRepository } from "../src/modules/orders/order.repository.js";
import { orderService } from "../src/modules/orders/order.service.js";
import { outboxPublisher } from "../src/modules/outbox/outbox.publisher.js";
import * as orderQueueModule from "../src/queues/order.queue.js";
import { processOrderJob } from "../src/workers/order.worker.js";

const prisma = new PrismaClient();

describe("Order Reservation Expiration & Auto-Release", () => {
  const prefix = `expire-test-${Date.now()}`;

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.processedEvent.deleteMany({
      where: { eventId: { startsWith: "order-expiration-" } },
    });
    await prisma.payment.deleteMany({
      where: { order: { customerId: { startsWith: prefix } } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });
    await prisma.orderStatusHistory.deleteMany({
      where: { order: { customerId: { startsWith: prefix } } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { customerId: { startsWith: prefix } } },
    });
    await prisma.order.deleteMany({
      where: { customerId: { startsWith: prefix } },
    });
    await prisma.inventory.deleteMany({
      where: { product: { name: { startsWith: prefix } } },
    });
    await prisma.product.deleteMany({
      where: { name: { startsWith: prefix } },
    });
    await prisma.$disconnect();
  });

  describe("Single Order Expiration (POST /orders/:id/expire)", () => {
    it("should atomically expire a pending order, release reserved inventory, and emit outbox event", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-A`,
          price: 150,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      // Create order with 3 units
      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-cust-1`,
          idempotencyKey: `${prefix}-ord-1`,
          items: [{ productId: product.id, quantity: 3 }],
        });

      expect(createRes.status).toBe(201);
      const orderId = createRes.body.data.id;

      // Verify inventory reservation
      let inventory = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(inventory?.available).toBe(7);
      expect(inventory?.reserved).toBe(3);

      // Trigger expiration
      const expireRes = await request(app).post(`/orders/${orderId}/expire`);
      expect(expireRes.status).toBe(200);
      expect(expireRes.body.data.status).toBe("CANCELLED");

      // Verify inventory was restored
      inventory = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(inventory?.available).toBe(10);
      expect(inventory?.reserved).toBe(0);

      // Verify status history
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
      });
      const expireHistory = history.find((h) => h.status === "CANCELLED");
      expect(expireHistory).toBeDefined();
      expect(expireHistory?.note).toContain("reservation expired");

      // Verify Outbox Event
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: { aggregateId: orderId, eventType: "ORDER_EXPIRED" },
      });
      expect(outboxEvent).not.toBeNull();
      expect(outboxEvent?.payload).toMatchObject({
        orderId,
        customerId: `${prefix}-cust-1`,
        reason: "RESERVATION_TIMEOUT",
      });
    });

    it("should reject expiration with 409 if order is already CONFIRMED (paid)", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-B`,
          price: 200,
          inventory: {
            create: {
              available: 5,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-cust-2`,
          items: [{ productId: product.id, quantity: 2 }],
        });
      const orderId = createRes.body.data.id;

      // Pay and confirm the order
      const payRes = await request(app).post(`/orders/${orderId}/pay`);
      expect(payRes.status).toBe(200);

      // Attempt expiration on confirmed order
      const expireRes = await request(app).post(`/orders/${orderId}/expire`);
      expect(expireRes.status).toBe(409);
      expect(expireRes.body.error.code).toBe(
        "ORDER_NOT_ELIGIBLE_FOR_EXPIRATION",
      );

      // Inventory remains reserved for fulfillment
      const inventory = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(inventory?.reserved).toBe(2);
      expect(inventory?.available).toBe(3);
    });

    it("should reject expiration with 409 if order is already CANCELLED", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-C`,
          price: 50,
          inventory: {
            create: {
              available: 8,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-cust-3`,
          items: [{ productId: product.id, quantity: 1 }],
        });
      const orderId = createRes.body.data.id;

      // Manually cancel
      const cancelRes = await request(app).patch(`/orders/${orderId}/cancel`);
      expect(cancelRes.status).toBe(200);

      // Attempt expiration on cancelled order
      const expireRes = await request(app).post(`/orders/${orderId}/expire`);
      expect(expireRes.status).toBe(409);
      expect(expireRes.body.error.code).toBe(
        "ORDER_NOT_ELIGIBLE_FOR_EXPIRATION",
      );
    });

    it("should return 404 for a non-existent order ID", async () => {
      const expireRes = await request(app).post(
        "/orders/non-existent-order-id/expire",
      );
      expect(expireRes.status).toBe(404);
      expect(expireRes.body.error.code).toBe("ORDER_NOT_FOUND");
    });
  });

  describe("Automatic Expiration Scheduling on Order Creation", () => {
    it("should schedule a delayed expiration job when order is created", async () => {
      const enqueueSpy = vi.spyOn(
        orderQueueModule,
        "enqueueOrderExpiration",
      );

      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-D`,
          price: 80,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-cust-4`,
          items: [{ productId: product.id, quantity: 2 }],
        });

      expect(createRes.status).toBe(201);
      const orderId = createRes.body.data.id;

      expect(enqueueSpy).toHaveBeenCalled();
      const lastCall = enqueueSpy.mock.calls[enqueueSpy.mock.calls.length - 1];
      expect(lastCall).toBeDefined();
      expect(lastCall![0]).toBe(orderId);
      expect(lastCall![1]).toBeGreaterThanOrEqual(1000); // positive delay ms
    });

    it("should create order successfully even if enqueueOrderExpiration fails (Graceful Degradation)", async () => {
      vi.spyOn(orderQueueModule, "enqueueOrderExpiration").mockRejectedValueOnce(
        new Error("Redis queue down"),
      );

      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-E`,
          price: 120,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-cust-5`,
          items: [{ productId: product.id, quantity: 1 }],
        });

      // Order creation still succeeds! Sweeper will reconcile it later.
      expect(createRes.status).toBe(201);
      expect(createRes.body.data.status).toBe("PENDING");
    });
  });

  describe("Administrative Stale Order Sweeper (POST /orders/admin/expire-stale)", () => {
    it("should identify and expire only orders older than cutoff threshold", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-F`,
          price: 60,
          inventory: {
            create: {
              available: 20,
              reserved: 0,
            },
          },
        },
      });

      // Order 1: Stale (backdated 30 minutes ago)
      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-stale-cust`,
          status: "PENDING",
          total: 120,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 60 }],
          },
        },
      });
      // Reserve inventory for stale order
      await prisma.inventory.update({
        where: { productId: product.id },
        data: { available: { decrement: 2 }, reserved: { increment: 2 } },
      });

      // Order 2: Fresh (created just now)
      const freshOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-fresh-cust`,
          status: "PENDING",
          total: 60,
          createdAt: new Date(),
          items: {
            create: [{ productId: product.id, quantity: 1, unitPrice: 60 }],
          },
        },
      });
      // Reserve inventory for fresh order
      await prisma.inventory.update({
        where: { productId: product.id },
        data: { available: { decrement: 1 }, reserved: { increment: 1 } },
      });

      // Current inventory state: available = 17, reserved = 3
      let invBefore = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invBefore?.available).toBe(17);
      expect(invBefore?.reserved).toBe(3);

      // Run sweeper with olderThanSeconds = 900 (15 minutes)
      const sweepRes = await request(app)
        .post("/orders/admin/expire-stale")
        .query({ olderThanSeconds: 900 });

      expect(sweepRes.status).toBe(200);
      expect(sweepRes.body.data.expiredCount).toBeGreaterThanOrEqual(1);
      expect(sweepRes.body.data.orderIds).toContain(staleOrder.id);
      expect(sweepRes.body.data.orderIds).not.toContain(freshOrder.id);

      // Verify stale order cancelled and inventory returned
      const staleAfter = await prisma.order.findUnique({
        where: { id: staleOrder.id },
      });
      expect(staleAfter?.status).toBe("CANCELLED");

      // Verify fresh order remains pending
      const freshAfter = await prisma.order.findUnique({
        where: { id: freshOrder.id },
      });
      expect(freshAfter?.status).toBe("PENDING");

      // Inventory check: 2 items from stale order restored: available = 19, reserved = 1
      const invAfter = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invAfter?.available).toBe(19);
      expect(invAfter?.reserved).toBe(1);
    });

    it("should reject invalid olderThanSeconds query parameters with 400", async () => {
      const invalidValues = [-5, 0, "invalid-number"];

      for (const val of invalidValues) {
        const res = await request(app)
          .post("/orders/admin/expire-stale")
          .query({ olderThanSeconds: val });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("Outbox Publisher ORDER_EXPIRED Processing", () => {
    it("should mark ORDER_EXPIRED events as processed without error", async () => {
      const orderId = `${prefix}-outbox-ord`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_EXPIRED",
          aggregateId: orderId,
          payload: {
            orderId,
            customerId: `${prefix}-outbox-cust`,
            reason: "RESERVATION_TIMEOUT",
          },
        },
      });

      const result = await outboxPublisher.publishPendingEvents();
      expect(result.found).toBeGreaterThanOrEqual(1);

      const updated = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      expect(updated?.processedAt).not.toBeNull();
      expect(updated?.lastError).toBeNull();
      expect(updated?.attempts).toBe(1);
    });
  });

  describe("BullMQ Worker order-expiration Job Handling", () => {
    it("should process order-expiration job and release reserved stock", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Worker-1`,
          price: 99,
          inventory: {
            create: {
              available: 10,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-worker-cust-1`,
          items: [{ productId: product.id, quantity: 4 }],
        });

      const orderId = createRes.body.data.id;

      // Execute worker job directly
      const result = await processOrderJob({
        name: "order-expiration",
        data: { orderId },
        id: `job-worker-${orderId}`,
      });

      expect(result).toEqual({
        success: true,
        orderId,
        expired: true,
        duplicate: false,
      });

      // Verify order cancelled
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe("CANCELLED");

      // Verify inventory released back to 10 available
      const inventory = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(inventory?.available).toBe(10);
      expect(inventory?.reserved).toBe(0);
    });

    it("should handle duplicate worker job executions idempotently without error", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Worker-2`,
          price: 50,
          inventory: {
            create: {
              available: 5,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-worker-cust-2`,
          items: [{ productId: product.id, quantity: 1 }],
        });

      const orderId = createRes.body.data.id;

      // Run 1
      const res1 = await processOrderJob({
        name: "order-expiration",
        data: { orderId },
        id: `job-worker-dup-${orderId}`,
      });
      expect(res1.success).toBe(true);
      expect(res1.duplicate).toBe(false);

      // Run 2 (duplicate delivery from BullMQ)
      const res2 = await processOrderJob({
        name: "order-expiration",
        data: { orderId },
        id: `job-worker-dup-${orderId}`,
      });
      expect(res2.success).toBe(true);
      expect(res2.duplicate).toBe(true);
    });

    it("should safely no-op when processing order-expiration for an already confirmed order", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Worker-3`,
          price: 75,
          inventory: {
            create: {
              available: 5,
              reserved: 0,
            },
          },
        },
      });

      const createRes = await request(app)
        .post("/orders")
        .send({
          customerId: `${prefix}-worker-cust-3`,
          items: [{ productId: product.id, quantity: 1 }],
        });

      const orderId = createRes.body.data.id;

      // Pay order
      await request(app).post(`/orders/${orderId}/pay`);

      // Run expiration worker job
      const result = await processOrderJob({
        name: "order-expiration",
        data: { orderId },
        id: `job-worker-paid-${orderId}`,
      });

      expect(result).toEqual({
        success: true,
        orderId,
        expired: false,
        duplicate: false,
      });

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe("CONFIRMED");
    });
  });
});
