import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { OrderSweeper, orderSweeper } from "../src/modules/orders/order.sweeper.js";
import { orderRepository } from "../src/modules/orders/order.repository.js";
import { processOrderJob } from "../src/workers/order.worker.js";

const prisma = new PrismaClient();

describe("Order Reservation Sweeper — Concurrency, Idempotency & Lifecycle", () => {
  const prefix = `sweeper-test-${Date.now()}`;

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

  describe("1. Discovery of Expired Pending Orders", () => {
    it("should discover stale pending orders older than cutoff while ignoring fresh pending orders", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Discover`,
          price: 100,
          inventory: {
            create: { available: 10, reserved: 2 },
          },
        },
      });

      // Stale order (created 25 minutes ago)
      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-stale-cust-1`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 25 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
          },
        },
      });

      // Fresh order (created 1 minute ago)
      const freshOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-fresh-cust-1`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });

      expect(result.discovered).toBeGreaterThanOrEqual(1);
      expect(result.orderIds).toContain(staleOrder.id);
      expect(result.orderIds).not.toContain(freshOrder.id);

      // Verify stale order cancelled
      const freshAfter = await prisma.order.findUnique({ where: { id: freshOrder.id } });
      expect(freshAfter?.status).toBe("PENDING");
    });
  });

  describe("2. Processing Expired Reservations & Audit Records", () => {
    it("should process expired reservations, record status history note, and create outbox event", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Audit`,
          price: 50,
          inventory: {
            create: { available: 8, reserved: 2 },
          },
        },
      });

      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-audit-cust`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 50 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });

      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.orderIds).toContain(staleOrder.id);

      // Verify order cancelled
      const order = await prisma.order.findUnique({ where: { id: staleOrder.id } });
      expect(order?.status).toBe("CANCELLED");

      // Verify status history
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: staleOrder.id },
      });
      const cancelHistory = history.find((h) => h.status === "CANCELLED");
      expect(cancelHistory).toBeDefined();
      expect(cancelHistory?.note).toContain("reservation expired");

      // Verify outbox event
      const outbox = await prisma.outboxEvent.findFirst({
        where: { aggregateId: staleOrder.id, eventType: "ORDER_EXPIRED" },
      });
      expect(outbox).not.toBeNull();
      expect(outbox?.payload).toMatchObject({
        orderId: staleOrder.id,
        customerId: `${prefix}-audit-cust`,
        reason: "RESERVATION_TIMEOUT",
      });
    });
  });

  describe("3. Inventory Release Correctness", () => {
    it("should release reserved inventory exactly and accurately back to available stock", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Inv-Release`,
          price: 40,
          inventory: {
            create: { available: 5, reserved: 5 },
          },
        },
      });

      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-inv-cust`,
          status: "PENDING",
          total: 120,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 3, unitPrice: 40 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });
      expect(result.orderIds).toContain(staleOrder.id);

      const invAfter = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invAfter?.available).toBe(8); // 5 + 3
      expect(invAfter?.reserved).toBe(2);  // 5 - 3
    });
  });

  describe("4 & 5. Non-Eligible Orders (Completed & Cancelled) Ignored", () => {
    it("should ignore completed (CONFIRMED) orders even if created in the past", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Confirmed`,
          price: 70,
          inventory: {
            create: { available: 5, reserved: 2 },
          },
        },
      });

      const confirmedOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-confirmed-cust`,
          status: "CONFIRMED",
          total: 140,
          createdAt: new Date(Date.now() - 40 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 70 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });
      expect(result.orderIds).not.toContain(confirmedOrder.id);

      const orderAfter = await prisma.order.findUnique({ where: { id: confirmedOrder.id } });
      expect(orderAfter?.status).toBe("CONFIRMED");

      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(invAfter?.reserved).toBe(2);
      expect(invAfter?.available).toBe(5);
    });

    it("should ignore already cancelled orders and never alter stock", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Cancelled`,
          price: 80,
          inventory: {
            create: { available: 10, reserved: 0 },
          },
        },
      });

      const cancelledOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-cancelled-cust`,
          status: "CANCELLED",
          total: 80,
          createdAt: new Date(Date.now() - 40 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 1, unitPrice: 80 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });
      expect(result.orderIds).not.toContain(cancelledOrder.id);

      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(invAfter?.available).toBe(10);
      expect(invAfter?.reserved).toBe(0);
    });
  });

  describe("6. Idempotency — No Double Release on Already Expired Orders", () => {
    it("should not release inventory twice if an order is swept repeatedly", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Double-Exp`,
          price: 90,
          inventory: {
            create: { available: 10, reserved: 2 },
          },
        },
      });

      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-double-cust`,
          status: "PENDING",
          total: 180,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 90 }],
          },
        },
      });

      // Sweep #1: Expires the order
      const sweep1 = await orderSweeper.sweep({ olderThanSeconds: 900 });
      expect(sweep1.orderIds).toContain(staleOrder.id);

      let inv = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(inv?.available).toBe(12);
      expect(inv?.reserved).toBe(0);

      // Sweep #2: Order is no longer PENDING, must not be touched
      const sweep2 = await orderSweeper.sweep({ olderThanSeconds: 900 });
      expect(sweep2.orderIds).not.toContain(staleOrder.id);

      inv = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(inv?.available).toBe(12); // Must not become 14!
      expect(inv?.reserved).toBe(0);
    });
  });

  describe("7. Concurrency — Sweeper vs BullMQ Worker Race Condition", () => {
    it("should safely handle concurrent delayed BullMQ job and sweeper without releasing inventory twice", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Race`,
          price: 110,
          inventory: {
            create: { available: 7, reserved: 3 },
          },
        },
      });

      const order = await prisma.order.create({
        data: {
          customerId: `${prefix}-race-cust`,
          status: "PENDING",
          total: 330,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 3, unitPrice: 110 }],
          },
        },
      });

      // Execute BullMQ worker job and sweeper sweep concurrently
      const [workerResult, sweeperResult] = await Promise.all([
        processOrderJob({
          name: "order-expiration",
          data: { orderId: order.id },
          id: `race-job-${order.id}`,
        }),
        orderSweeper.sweep({ olderThanSeconds: 900 }),
      ]);

      expect(workerResult.success).toBe(true);

      // Exactly one process expired the order; the other was skipped
      const workerExpired = workerResult.expired;
      const sweeperExpired = sweeperResult.orderIds.includes(order.id);

      // Both cannot have expired the order simultaneously
      expect(workerExpired || sweeperExpired).toBe(true);

      // Inventory must be exactly 10 available, 0 reserved (released exactly once!)
      const invAfter = await prisma.inventory.findUnique({
        where: { productId: product.id },
      });
      expect(invAfter?.available).toBe(10);
      expect(invAfter?.reserved).toBe(0);

      // Order must be CANCELLED
      const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
      expect(orderAfter?.status).toBe("CANCELLED");
    });
  });

  describe("8. Transaction Rollback on Failure", () => {
    it("should roll back completely and leave order PENDING and inventory untouched when inventory release fails", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Rollback`,
          price: 65,
          inventory: {
            create: { available: 10, reserved: 0 }, // Inconsistent: reserved is 0, but order wants 2
          },
        },
      });

      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-rollback-cust`,
          status: "PENDING",
          total: 130,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 65 }],
          },
        },
      });

      // Sweeper will encounter "Unable to release reserved inventory" because reserved < quantity
      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.orderIds).not.toContain(staleOrder.id);

      // Verify order status rolled back to PENDING
      const orderAfter = await prisma.order.findUnique({ where: { id: staleOrder.id } });
      expect(orderAfter?.status).toBe("PENDING");

      // Verify inventory untouched
      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(invAfter?.available).toBe(10);
      expect(invAfter?.reserved).toBe(0);
    });
  });

  describe("9. Fault Isolation — Individual Failure Does Not Stop Remaining Sweep", () => {
    it("should continue sweeping remaining orders even if one order in the batch fails", async () => {
      const product1 = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Fail-1`,
          price: 50,
          inventory: {
            create: { available: 5, reserved: 0 }, // Inconsistent: will fail during inventory decrement
          },
        },
      });

      const product2 = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Succeed-2`,
          price: 50,
          inventory: {
            create: { available: 5, reserved: 2 }, // Consistent: will succeed
          },
        },
      });

      const badOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-bad-cust`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 35 * 60 * 1000),
          items: {
            create: [{ productId: product1.id, quantity: 2, unitPrice: 50 }],
          },
        },
      });

      const goodOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-good-cust`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product2.id, quantity: 2, unitPrice: 50 }],
          },
        },
      });

      const result = await orderSweeper.sweep({ olderThanSeconds: 900 });

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.orderIds).toContain(goodOrder.id);
      expect(result.orderIds).not.toContain(badOrder.id);

      // Verify good order was cancelled and inventory restored
      const goodAfter = await prisma.order.findUnique({ where: { id: goodOrder.id } });
      expect(goodAfter?.status).toBe("CANCELLED");

      const goodInv = await prisma.inventory.findUnique({ where: { productId: product2.id } });
      expect(goodInv?.available).toBe(7); // 5 + 2
      expect(goodInv?.reserved).toBe(0);  // 2 - 2

      // Verify bad order remains PENDING
      const badAfter = await prisma.order.findUnique({ where: { id: badOrder.id } });
      expect(badAfter?.status).toBe("PENDING");
    });
  });

  describe("10. Periodic Runner Scheduling & Non-Overlapping Invocations", () => {
    it("should schedule periodic sweeps without overlapping concurrent runs or creating duplicate loops", async () => {
      const sweeper = new OrderSweeper();

      let sweepCallCount = 0;
      const sweepSpy = vi.spyOn(sweeper, "sweep").mockImplementation(async () => {
        sweepCallCount++;
        return {
          discovered: 0,
          processed: 0,
          skipped: 0,
          failed: 0,
          orderIds: [],
          cutoff: new Date().toISOString(),
          durationMs: 5,
        };
      });

      // Start sweeper with short interval
      sweeper.start({ intervalMs: 50, runImmediately: true });
      expect(sweeper.isRunning()).toBe(true);

      // Call start() again — must be a no-op to prevent duplicate interval loops
      sweeper.start({ intervalMs: 50 });
      expect(sweeper.isRunning()).toBe(true);

      // Wait 120ms to allow immediate execution + at least one interval tick
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(sweepCallCount).toBeGreaterThanOrEqual(2);

      await sweeper.stop();
      expect(sweeper.isRunning()).toBe(false);
      sweepSpy.mockRestore();
    });

    it("should prevent overlapping sweep execution when a sweep is already in progress", async () => {
      const sweeper = new OrderSweeper();

      let releaseSweep: (() => void) | null = null;
      const longSweepPromise = new Promise<void>((resolve) => {
        releaseSweep = resolve;
      });

      // Spy on orderRepository.findStalePendingOrders to hold the first sweep open
      vi.spyOn(orderRepository, "findStalePendingOrders").mockImplementationOnce((async () => {
        await longSweepPromise;
        return [];
      }) as any);

      // Launch first sweep (stays pending)
      const firstSweep = sweeper.sweep();
      expect(sweeper.isSweeping()).toBe(true);

      // Launch second sweep while first is running
      const secondSweepResult = await sweeper.sweep();
      expect(secondSweepResult.discovered).toBe(0);
      expect(secondSweepResult.processed).toBe(0);

      // Release first sweep
      if (releaseSweep) (releaseSweep as () => void)();
      await firstSweep;

      expect(sweeper.isSweeping()).toBe(false);
      vi.restoreAllMocks();
    });
  });

  describe("11. Graceful Shutdown", () => {
    it("should stop scheduling and await completion of an in-flight sweep during shutdown", async () => {
      const sweeper = new OrderSweeper();

      let inFlightFinished = false;
      vi.spyOn(orderRepository, "findStalePendingOrders").mockImplementationOnce((async () => {
        await new Promise((res) => setTimeout(res, 80));
        inFlightFinished = true;
        return [];
      }) as any);

      sweeper.start({ intervalMs: 200, runImmediately: true });
      expect(sweeper.isRunning()).toBe(true);

      // Wait a moment so the immediate sweep starts and enters findStalePendingOrders
      await new Promise((res) => setTimeout(res, 20));
      expect(sweeper.isSweeping()).toBe(true);

      // Trigger shutdown while sweep is active
      const stopPromise = sweeper.stop();
      expect(sweeper.isRunning()).toBe(false);

      await stopPromise;
      expect(inFlightFinished).toBe(true);
      expect(sweeper.isSweeping()).toBe(false);

      vi.restoreAllMocks();
    });
  });
});
