import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  ADVISORY_LOCK_IDS,
  PostgresAdvisoryLock,
} from "../src/shared/advisory-lock.js";
import { OrderSweeper } from "../src/modules/orders/order.sweeper.js";
import { outboxPublisher } from "../src/modules/outbox/outbox.publisher.js";
import { processOutbox, outboxLock } from "../src/modules/outbox/outbox.runner.js";
import { processOrderJob } from "../src/workers/order.worker.js";

const prisma = new PrismaClient();

describe("Distributed Advisory Locking for Background Workers", () => {
  const prefix = `lock-test-${Date.now()}`;

  afterAll(async () => {
    vi.restoreAllMocks();
    await outboxLock.disconnect();
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

  describe("1. Successful Lock Acquisition", () => {
    it("should acquire and release a session-level advisory lock successfully", async () => {
      const lock = new PostgresAdvisoryLock({
        lockId: 100_101,
        name: "test-lock-1",
      });

      const acquired = await lock.acquire();
      expect(acquired).toBe(true);
      expect(lock.isLocked()).toBe(true);
      expect(lock.isConnected()).toBe(true);

      const released = await lock.release();
      expect(released).toBe(true);
      expect(lock.isLocked()).toBe(false);

      await lock.disconnect();
    });
  });

  describe("2. Lock Contention: Second Replica Skips Execution", () => {
    it("should allow only one instance to hold the lock while rejecting the other non-blockingly", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_102,
        name: "instance-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_102,
        name: "instance-2",
      });

      // Instance 1 acquires
      const acquired1 = await lock1.acquire();
      expect(acquired1).toBe(true);

      // Instance 2 attempts to acquire the exact same lock ID
      const acquired2 = await lock2.acquire();
      expect(acquired2).toBe(false);
      expect(lock2.isLocked()).toBe(false);

      // Instance 1 releases
      await lock1.release();

      // Now Instance 2 can acquire
      const acquired2After = await lock2.acquire();
      expect(acquired2After).toBe(true);

      await lock2.release();
      await lock1.disconnect();
      await lock2.disconnect();
    });

    it("should skip execution gracefully when another replica holds the lock", async () => {
      const holder = new PostgresAdvisoryLock({
        lockId: 100_103,
        name: "contention-holder",
      });
      const runner = new PostgresAdvisoryLock({
        lockId: 100_103,
        name: "contention-runner",
      });

      await holder.acquire();

      let executed = false;
      const res = await runner.withLock(async () => {
        executed = true;
      });

      expect(res.acquired).toBe(false);
      expect(res.skippedReason).toBe("LOCK_HELD_BY_ANOTHER_INSTANCE");
      expect(executed).toBe(false);

      await holder.release();
      await holder.disconnect();
      await runner.disconnect();
    });
  });

  describe("3. Lock Release After Successful Execution", () => {
    it("should release lock in finally block after successful withLock execution", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_104,
        name: "auto-release-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_104,
        name: "auto-release-2",
      });

      const res = await lock1.withLock(async () => {
        return "work-done";
      });

      expect(res.acquired).toBe(true);
      expect(res.result).toBe("work-done");
      expect(lock1.isLocked()).toBe(false);

      // lock2 can immediately acquire
      const acquired = await lock2.acquire();
      expect(acquired).toBe(true);
      await lock2.release();

      await lock1.disconnect();
      await lock2.disconnect();
    });
  });

  describe("4. Lock Release After an Exception", () => {
    it("should release lock in finally block even when the protected action throws an exception", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_105,
        name: "exception-lock-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_105,
        name: "exception-lock-2",
      });

      let caughtError = false;
      try {
        await lock1.withLock(async () => {
          throw new Error("Simulated critical failure during sweep");
        });
      } catch (err) {
        caughtError = true;
      }

      expect(caughtError).toBe(true);
      expect(lock1.isLocked()).toBe(false);

      // Lock was safely released in finally block; lock2 must be able to acquire
      const acquired2 = await lock2.acquire();
      expect(acquired2).toBe(true);
      await lock2.release();

      await lock1.disconnect();
      await lock2.disconnect();
    });
  });

  describe("5. Database Connection/Acquisition Failure", () => {
    it("should fail-closed safely (return false) when database connection cannot be established", async () => {
      const lock = new PostgresAdvisoryLock({
        lockId: 100_106,
        name: "fail-connection-lock",
        connectionString: "postgresql://orderflow:orderflow_test@127.0.0.1:54399/nonexistent?connect_timeout=1",
      });

      const acquired = await lock.acquire();
      expect(acquired).toBe(false);
      expect(lock.isLocked()).toBe(false);
      expect(lock.isConnected()).toBe(false);

      let actionCalled = false;
      const res = await lock.withLock(async () => {
        actionCalled = true;
      });

      expect(res.acquired).toBe(false);
      expect(actionCalled).toBe(false);
      await lock.disconnect();
    });

    it("should handle query execution failure during acquire safely without throwing uncaught errors", async () => {
      const lock = new PostgresAdvisoryLock({
        lockId: 100_107,
        name: "query-fail-lock",
      });

      await lock.connect();
      const client = (lock as unknown as { client: { query: unknown } }).client;
      const originalQuery = client.query;
      client.query = vi.fn().mockRejectedValueOnce(new Error("FATAL: connection terminated unexpectedly"));

      const acquired = await lock.acquire();
      expect(acquired).toBe(false);
      expect(lock.isLocked()).toBe(false);

      client.query = originalQuery;
      await lock.disconnect();
    });
  });

  describe("6. Separate Lock Identifiers for the Two Workers", () => {
    it("should allow sweeper and outbox publisher to hold their respective locks concurrently without blocking", async () => {
      const sweeperLock = new PostgresAdvisoryLock({
        lockId: ADVISORY_LOCK_IDS.ORDER_SWEEPER,
        name: "sweeper-lock",
      });
      const outboxLockInstance = new PostgresAdvisoryLock({
        lockId: ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER,
        name: "outbox-lock",
      });

      const sweeperAcquired = await sweeperLock.acquire();
      const outboxAcquired = await outboxLockInstance.acquire();

      expect(sweeperAcquired).toBe(true);
      expect(outboxAcquired).toBe(true);

      await sweeperLock.release();
      await outboxLockInstance.release();
      await sweeperLock.disconnect();
      await outboxLockInstance.disconnect();
    });
  });

  describe("7. No Execution When Lock Cannot Be Acquired", () => {
    it("should only execute protected action when lock is successfully acquired", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_108,
        name: "owner-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_108,
        name: "contender-2",
      });

      let fn1Executed = false;
      let fn2Executed = false;

      // Lock1 acquires and executes action
      const executionPromise1 = lock1.withLock(async () => {
        // While lock1 holds the lock, lock2 attempts to run withLock
        const res2 = await lock2.withLock(async () => {
          fn2Executed = true;
          return "from-lock-2";
        });

        expect(res2.acquired).toBe(false);
        fn1Executed = true;
        return "from-lock-1";
      });

      const res1 = await executionPromise1;
      expect(res1.acquired).toBe(true);
      expect(res1.result).toBe("from-lock-1");
      expect(fn1Executed).toBe(true);
      expect(fn2Executed).toBe(false);

      await lock1.disconnect();
      await lock2.disconnect();
    });
  });

  describe("8. Existing Sweeper Concurrency Protections Still Work", () => {
    it("should maintain local in-process overlap guard alongside distributed locking", async () => {
      const sweeper = new OrderSweeper();

      // First sweep begins
      const firstSweep = sweeper.sweep();
      expect(sweeper.isSweeping()).toBe(true);

      // Second local call skips immediately via in-process mutex
      const secondSweepResult = await sweeper.sweep();
      expect(secondSweepResult.discovered).toBe(0);
      expect(secondSweepResult.processed).toBe(0);

      await firstSweep;
      expect(sweeper.isSweeping()).toBe(false);
    });

    it("should allow BullMQ worker job to safely expire reservations even if advisory lock is active", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-Worker-Safe`,
          price: 100,
          inventory: {
            create: { available: 5, reserved: 2 },
          },
        },
      });

      const order = await prisma.order.create({
        data: {
          customerId: `${prefix}-worker-safe-cust`,
          status: "PENDING",
          total: 200,
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 100 }],
          },
        },
      });

      const workerRes = await processOrderJob({
        name: "order-expiration",
        data: { orderId: order.id },
        id: `job-safe-${order.id}`,
      });

      expect(workerRes.success).toBe(true);
      expect(workerRes.expired).toBe(true);

      const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
      expect(orderAfter?.status).toBe("CANCELLED");

      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(invAfter?.available).toBe(7);
      expect(invAfter?.reserved).toBe(0);
    });

    it("should release inventory exactly once when two sweeper instances race", async () => {
      const product = await prisma.product.create({
        data: {
          name: `${prefix}-Item-No-Double`,
          price: 50,
          inventory: {
            create: { available: 8, reserved: 2 },
          },
        },
      });

      const staleOrder = await prisma.order.create({
        data: {
          customerId: `${prefix}-no-double-cust`,
          status: "PENDING",
          total: 100,
          createdAt: new Date(Date.now() - 30 * 60 * 1000),
          items: {
            create: [{ productId: product.id, quantity: 2, unitPrice: 50 }],
          },
        },
      });

      const sweeper1 = new OrderSweeper();
      const sweeper2 = new OrderSweeper();

      const [res1, res2] = await Promise.all([
        sweeper1.sweep({ olderThanSeconds: 900 }),
        sweeper2.sweep({ olderThanSeconds: 900 }),
      ]);

      const totalExpired =
        (res1.orderIds.includes(staleOrder.id) ? 1 : 0) +
        (res2.orderIds.includes(staleOrder.id) ? 1 : 0);

      expect(totalExpired).toBe(1);

      const invAfter = await prisma.inventory.findUnique({ where: { productId: product.id } });
      expect(invAfter?.available).toBe(10);
      expect(invAfter?.reserved).toBe(0);
    });
  });

  describe("9. Existing Outbox Retry and Publishing Behavior Remains Correct", () => {
    it("should skip execution without losing events or marking them processed when outbox lock is held", async () => {
      // Simulate another instance holding the outbox lock
      const simulatedInstance1 = new PostgresAdvisoryLock({
        lockId: ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER,
        name: "simulated-outbox-replica-1",
      });
      await simulatedInstance1.acquire();

      // Create an outbox event
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: `${prefix}-outbox-test-order`,
          payload: { orderId: `${prefix}-outbox-test-order`, customerId: `${prefix}-cust` },
        },
      });

      // Runner instance 2 attempts to process outbox; lock is held by instance 1
      const processResult = await processOutbox();
      expect(processResult.executed).toBe(false);

      // Verify event is completely untouched (not processed, not deleted, no attempt increments)
      const eventAfterSkip = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
      expect(eventAfterSkip?.processedAt).toBeNull();
      expect(eventAfterSkip?.attempts).toBe(0);

      // Instance 1 finishes and releases lock
      await simulatedInstance1.release();
      await simulatedInstance1.disconnect();

      // Now processOutbox acquires the lock and processes the event successfully
      const secondProcessResult = await processOutbox();
      expect(secondProcessResult.executed).toBe(true);

      const eventAfterProcess = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
      expect(eventAfterProcess?.processedAt).not.toBeNull();
    });

    it("should record retry attempts and error message on publishing failure, then recover and mark processed on retry", async () => {
      const orderId = `${prefix}-outbox-retry-order`;
      const customerId = `${prefix}-retry-cust`;

      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId },
        },
      });

      // Simulate a transient downstream failure in the queue
      const queueModule = await import("../src/queues/order.queue.js");
      const enqueueSpy = vi.spyOn(queueModule, "enqueueOrderConfirmation")
        .mockRejectedValueOnce(new Error("Simulated BullMQ Redis connection timeout"));

      // Publish under advisory lock (first attempt fails)
      const lock = new PostgresAdvisoryLock({
        lockId: 100_109,
        name: "outbox-retry-test-lock",
      });

      await lock.withLock(async () => {
        const res = await outboxPublisher.publishPendingEvents();
        expect(res.failed).toBeGreaterThanOrEqual(1);
      });

      const failedEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
      expect(failedEvent?.attempts).toBe(1);
      expect(failedEvent?.processedAt).toBeNull();
      expect(failedEvent?.lastError).toContain("Simulated BullMQ Redis connection timeout");
      expect(failedEvent?.nextAttemptAt).not.toBeNull();

      // Fast-forward nextAttemptAt so the event enters its retry eligibility window
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      // Second attempt succeeds (retry)
      await lock.withLock(async () => {
        const res = await outboxPublisher.publishPendingEvents();
        expect(res.published).toBeGreaterThanOrEqual(1);
      });

      const recoveredEvent = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
      expect(recoveredEvent?.attempts).toBe(2);
      expect(recoveredEvent?.processedAt).not.toBeNull();
      expect(recoveredEvent?.lastError).toBeNull();

      enqueueSpy.mockRestore();
      await lock.disconnect();
    });
  });

  describe("10. Graceful Shutdown and Connection Cleanup", () => {
    it("should automatically release PostgreSQL session-level advisory lock when connection is closed", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_110,
        name: "disconnect-lock-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_110,
        name: "disconnect-lock-2",
      });

      // Instance 1 acquires lock
      const acquired1 = await lock1.acquire();
      expect(acquired1).toBe(true);

      // Instance 2 cannot acquire
      const acquired2Before = await lock2.acquire();
      expect(acquired2Before).toBe(false);

      // Terminate instance 1 connection abruptly (simulating container crash or network cutoff)
      await lock1.disconnect();

      // PostgreSQL backend for instance 1 has terminated; session locks are instantly released by the engine
      const acquired2After = await lock2.acquire();
      expect(acquired2After).toBe(true);

      await lock2.release();
      await lock2.disconnect();
    });

    it("should release lock, close client connection, and reset state flags cleanly on disconnect", async () => {
      const lock1 = new PostgresAdvisoryLock({
        lockId: 100_111,
        name: "clean-shutdown-lock-1",
      });
      const lock2 = new PostgresAdvisoryLock({
        lockId: 100_111,
        name: "clean-shutdown-lock-2",
      });

      const acquired = await lock1.acquire();
      expect(acquired).toBe(true);
      expect(lock1.isConnected()).toBe(true);
      expect(lock1.isLocked()).toBe(true);

      // Disconnect lock1
      await lock1.disconnect();
      expect(lock1.isConnected()).toBe(false);
      expect(lock1.isLocked()).toBe(false);

      // Disconnecting again is idempotent and harmless
      await expect(lock1.disconnect()).resolves.not.toThrow();

      // Contender can immediately acquire because lock was released and connection closed
      const contenderAcquired = await lock2.acquire();
      expect(contenderAcquired).toBe(true);

      await lock2.release();
      await lock2.disconnect();
    });

    it("should safely stop background sweeper loop and disconnect advisory lock on sweeper stop", async () => {
      const sweeper = new OrderSweeper();
      sweeper.start({
        useDistributedLock: true,
        intervalMs: 10000,
        runImmediately: false,
      });

      expect(sweeper.isRunning()).toBe(true);
      const advLock = sweeper.getAdvisoryLock();
      expect(advLock).not.toBeNull();

      await sweeper.stop();
      expect(sweeper.isRunning()).toBe(false);
      expect(sweeper.getAdvisoryLock()).toBeNull();
    });
  });
});
