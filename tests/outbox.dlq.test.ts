import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PrismaClient, OutboxStatus } from "@prisma/client";
import app from "../src/app.js";
import { outboxPublisher } from "../src/modules/outbox/outbox.publisher.js";
import { outboxRepository } from "../src/modules/outbox/outbox.repository.js";
import { outboxLock, processOutbox } from "../src/modules/outbox/outbox.runner.js";
import * as orderQueue from "../src/queues/order.queue.js";

const prisma = new PrismaClient();

describe("Dead-Letter Queue (DLQ) & Exponential Backoff for Outbox Events", () => {
  const prefix = `dlq-test-${Date.now()}`;

  afterAll(async () => {
    vi.restoreAllMocks();
    await outboxLock.disconnect();
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });
    await prisma.$disconnect();
  });

  describe("5. Event Not Retried Before nextAttemptAt", () => {
    it("should exclude failed event from subsequent publishing while within backoff delay", async () => {
      const orderId = `${prefix}-backoff-order-1`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-1" },
        },
      });

      // Simulate failure on first delivery attempt
      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValueOnce(new Error("Downstream service temporarily unreachable"));

      const firstRun = await outboxPublisher.publishPendingEvents({
        baseDelayMs: 10000, // 10s base delay
        enableJitter: false,
      });

      expect(firstRun.failed).toBe(1);

      const afterFirstRun = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      expect(afterFirstRun?.attempts).toBe(1);
      expect(afterFirstRun?.status).toBe(OutboxStatus.PENDING);
      expect(afterFirstRun?.processedAt).toBeNull();
      expect(afterFirstRun?.nextAttemptAt).not.toBeNull();
      expect(afterFirstRun?.lastError).toContain("Downstream service temporarily unreachable");

      // Verify that immediately running publisher again skips this event
      enqueueSpy.mockClear();
      const secondRun = await outboxPublisher.publishPendingEvents();
      expect(secondRun.found).toBe(0);
      expect(enqueueSpy).not.toHaveBeenCalled();

      // Ensure attempts count did not change
      const afterSecondRun = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      expect(afterSecondRun?.attempts).toBe(1);

      enqueueSpy.mockRestore();
    });
  });

  describe("6. Event Becomes Eligible After nextAttemptAt", () => {
    it("should retry and successfully publish event once nextAttemptAt timestamp has passed", async () => {
      const orderId = `${prefix}-backoff-order-2`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-2" },
        },
      });

      // First run fails
      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValueOnce(new Error("First transient failure"));

      await outboxPublisher.publishPendingEvents({
        baseDelayMs: 5000,
        enableJitter: false,
      });

      // Simulate passage of time by setting nextAttemptAt into the past
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      // Second run succeeds (downstream recovered)
      enqueueSpy.mockResolvedValueOnce({ id: "job-recovered" } as any);

      const retryRun = await outboxPublisher.publishPendingEvents();
      expect(retryRun.published).toBe(1);

      const finalEvent = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      expect(finalEvent?.status).toBe(OutboxStatus.PUBLISHED);
      expect(finalEvent?.processedAt).not.toBeNull();
      expect(finalEvent?.attempts).toBe(2);
      expect(finalEvent?.nextAttemptAt).toBeNull();
      expect(finalEvent?.lastError).toBeNull();

      enqueueSpy.mockRestore();
    });
  });

  describe("7. Event Transitions to DEAD_LETTER After Maximum Attempts", () => {
    it("should transition to DEAD_LETTER status when reaching maximum retry limit", async () => {
      const orderId = `${prefix}-dlq-order-1`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-dlq" },
        },
      });

      const maxAttempts = 3;
      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValue(new Error("Persistent critical downstream failure"));

      // Run attempts 1 through 3
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Ensure event is eligible for this attempt
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });

        const res = await outboxPublisher.publishPendingEvents({
          maxAttempts,
          baseDelayMs: 1000,
          enableJitter: false,
        });

        expect(res.failed).toBe(1);
      }

      const deadLetterEvent = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(deadLetterEvent?.status).toBe(OutboxStatus.DEAD_LETTER);
      expect(deadLetterEvent?.attempts).toBe(maxAttempts);
      expect(deadLetterEvent?.processedAt).toBeNull();
      expect(deadLetterEvent?.nextAttemptAt).toBeNull();
      expect(deadLetterEvent?.deadLetteredAt).not.toBeNull();
      expect(deadLetterEvent?.lastError).toContain("Persistent critical downstream failure");

      enqueueSpy.mockRestore();
    });
  });

  describe("8. Dead-Lettered Events Are Excluded from Publishing", () => {
    it("should never select DEAD_LETTER events during standard publishing cycles", async () => {
      const orderId = `${prefix}-dlq-excluded`;
      await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          status: OutboxStatus.DEAD_LETTER,
          attempts: 5,
          deadLetteredAt: new Date(),
          lastError: "Previously exceeded maximum retries",
          payload: { orderId, customerId: "cust-excluded" },
        },
      });

      const enqueueSpy = vi.spyOn(orderQueue, "enqueueOrderConfirmation");

      const run = await outboxPublisher.publishPendingEvents();
      expect(run.found).toBe(0);
      expect(enqueueSpy).not.toHaveBeenCalled();

      enqueueSpy.mockRestore();
    });
  });

  describe("9. Original Payload and Error Information Are Preserved", () => {
    it("should preserve original payload, identifiers, and final error on dead-letter transition", async () => {
      const orderId = `${prefix}-preserve-order`;
      const originalPayload = {
        orderId,
        customerId: "cust-original",
        metadata: { source: "checkout", priority: "high" },
      };

      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: originalPayload,
        },
      });

      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValue(new Error("Fatal serialization constraint violation"));

      await outboxPublisher.publishPendingEvents({ maxAttempts: 1 });

      const deadLetter = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(deadLetter?.status).toBe(OutboxStatus.DEAD_LETTER);
      expect(deadLetter?.eventType).toBe("ORDER_CONFIRMED");
      expect(deadLetter?.aggregateId).toBe(orderId);
      expect(deadLetter?.payload).toEqual(originalPayload);
      expect(deadLetter?.lastError).toBe("Fatal serialization constraint violation");

      enqueueSpy.mockRestore();
    });
  });

  describe("10. Retry Count Survives Application Restart", () => {
    it("should persist retry count and nextAttemptAt in PostgreSQL across client instances", async () => {
      const orderId = `${prefix}-restart-order`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-restart" },
        },
      });

      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValueOnce(new Error("Failure before simulated crash"));

      await outboxPublisher.publishPendingEvents({ baseDelayMs: 8000, enableJitter: false });

      // Create a brand new PrismaClient connection to simulate a new application process
      const freshPrisma = new PrismaClient();
      try {
        const persisted = await freshPrisma.outboxEvent.findUnique({
          where: { id: event.id },
        });

        expect(persisted?.attempts).toBe(1);
        expect(persisted?.status).toBe(OutboxStatus.PENDING);
        expect(persisted?.nextAttemptAt).not.toBeNull();
        expect(persisted?.lastError).toBe("Failure before simulated crash");
      } finally {
        await freshPrisma.$disconnect();
        enqueueSpy.mockRestore();
      }
    });
  });

  describe("11. Successful Retry Marks Event Correctly", () => {
    it("should mark status as PUBLISHED, clear nextAttemptAt and lastError on successful retry", async () => {
      const orderId = `${prefix}-success-retry-order`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-success" },
        },
      });

      // Attempt 1 fails
      const enqueueSpy = vi
        .spyOn(orderQueue, "enqueueOrderConfirmation")
        .mockRejectedValueOnce(new Error("Temporary network glitch"));

      await outboxPublisher.publishPendingEvents({ baseDelayMs: 5000 });

      // Fast-forward backoff window
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      // Attempt 2 succeeds
      enqueueSpy.mockResolvedValueOnce({ id: "job-success" } as any);
      await outboxPublisher.publishPendingEvents();

      const published = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(published?.status).toBe(OutboxStatus.PUBLISHED);
      expect(published?.processedAt).not.toBeNull();
      expect(published?.attempts).toBe(2);
      expect(published?.lastError).toBeNull();
      expect(published?.nextAttemptAt).toBeNull();

      enqueueSpy.mockRestore();
    });
  });

  describe("12. Existing Advisory Locking Still Works", () => {
    it("should coordinate outbox execution across distributed replicas using advisory locks", async () => {
      // Simulate another replica holding the outbox lock on its dedicated session
      const simulatedReplica = new (await import("../src/shared/advisory-lock.js")).PostgresAdvisoryLock({
        lockId: (await import("../src/shared/advisory-lock.js")).ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER,
        name: "simulated-outbox-replica",
      });
      await simulatedReplica.acquire();

      const orderId = `${prefix}-lock-coord-order`;
      await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-locked" },
        },
      });

      // Runner process skips execution cycle while lock is held by the other replica
      const result = await processOutbox();
      expect(result.executed).toBe(false);

      await simulatedReplica.release();
      await simulatedReplica.disconnect();
    });
  });

  describe("13. Existing Outbox Publishing Behavior Remains Correct", () => {
    it("should publish order confirmed event and record attempts = 1 on normal execution", async () => {
      const orderId = `${prefix}-normal-order`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-normal" },
        },
      });

      const result = await outboxPublisher.publishPendingEvents();
      expect(result.published).toBeGreaterThanOrEqual(1);

      const updated = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(updated?.status).toBe(OutboxStatus.PUBLISHED);
      expect(updated?.processedAt).not.toBeNull();
      expect(updated?.attempts).toBe(1);
      expect(updated?.lastError).toBeNull();
    });
  });

  describe("14. Concurrent Execution Does Not Corrupt Retry State", () => {
    it("should safely handle concurrent failure updates without corrupting database state", async () => {
      const orderId = `${prefix}-concurrent-order`;
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          payload: { orderId, customerId: "cust-concurrent" },
        },
      });

      // Execute concurrent failure handling on the same event
      const [res1, res2] = await Promise.all([
        outboxRepository.handleFailure(event, "Concurrent error 1", { baseDelayMs: 2000 }),
        outboxRepository.handleFailure(event, "Concurrent error 2", { baseDelayMs: 2000 }),
      ]);

      const updated = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(updated?.status).toBe(OutboxStatus.PENDING);
      expect(updated?.attempts).toBeGreaterThanOrEqual(1);
      expect(updated?.nextAttemptAt).not.toBeNull();
      expect(updated?.lastError).toMatch(/Concurrent error [12]/);
    });
  });

  describe("15. Dead-Letter Observability & Replay API", () => {
    it("should list dead-lettered events through administrative endpoint", async () => {
      const orderId = `${prefix}-api-dlq`;
      const deadEvent = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          status: OutboxStatus.DEAD_LETTER,
          attempts: 5,
          deadLetteredAt: new Date(),
          lastError: "Validation schema error in payload",
          payload: { orderId, customerId: "cust-api" },
        },
      });

      const res = await request(app).get("/admin/outbox/dead-letter");

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.pagination).toBeDefined();

      const found = res.body.data.find((e: any) => e.id === deadEvent.id);
      expect(found).toBeDefined();
      expect(found.status).toBe("DEAD_LETTER");
      expect(found.attempts).toBe(5);
      expect(found.lastError).toBe("Validation schema error in payload");
    });

    it("should retrieve single dead-letter event by ID", async () => {
      const orderId = `${prefix}-api-detail`;
      const deadEvent = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_EXPIRED",
          aggregateId: orderId,
          status: OutboxStatus.DEAD_LETTER,
          attempts: 5,
          deadLetteredAt: new Date(),
          lastError: "Downstream audit webhook 500",
          payload: { orderId, reason: "TIMEOUT" },
        },
      });

      const res = await request(app).get(`/admin/outbox/dead-letter/${deadEvent.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(deadEvent.id);
      expect(res.body.data.status).toBe("DEAD_LETTER");
    });

    it("should return 404 when querying non-existent dead-letter event", async () => {
      const res = await request(app).get("/admin/outbox/dead-letter/non-existent-id-123");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DEAD_LETTER_EVENT_NOT_FOUND");
    });

    it("should explicitly replay dead-letter event by resetting status to PENDING", async () => {
      const orderId = `${prefix}-replay-order`;
      const deadEvent = await prisma.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: orderId,
          status: OutboxStatus.DEAD_LETTER,
          attempts: 5,
          deadLetteredAt: new Date(),
          lastError: "Initial network partition",
          payload: { orderId, customerId: "cust-replayed" },
        },
      });

      const replayRes = await request(app).post(
        `/admin/outbox/dead-letter/${deadEvent.id}/replay`,
      );

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.data.status).toBe("PENDING");
      expect(replayRes.body.data.attempts).toBe(0);
      expect(replayRes.body.data.deadLetteredAt).toBeNull();

      // Now publisher can pick up the replayed event and process it
      const pubRes = await outboxPublisher.publishPendingEvents();
      expect(pubRes.published).toBeGreaterThanOrEqual(1);

      const afterReplayPublish = await prisma.outboxEvent.findUnique({
        where: { id: deadEvent.id },
      });
      expect(afterReplayPublish?.status).toBe(OutboxStatus.PUBLISHED);
      expect(afterReplayPublish?.processedAt).not.toBeNull();
    });

    it("should enforce admin authentication when ADMIN_API_KEY is configured", async () => {
      process.env.ADMIN_API_KEY = "super-secret-admin-key";

      try {
        // Without header -> 401
        const unauthorizedRes = await request(app).get("/admin/outbox/dead-letter");
        expect(unauthorizedRes.status).toBe(401);
        expect(unauthorizedRes.body.error.code).toBe("UNAUTHORIZED");

        // With invalid header -> 401
        const wrongKeyRes = await request(app)
          .get("/admin/outbox/dead-letter")
          .set("x-admin-key", "wrong-key");
        expect(wrongKeyRes.status).toBe(401);

        // With valid header -> 200
        const authorizedRes = await request(app)
          .get("/admin/outbox/dead-letter")
          .set("x-admin-key", "super-secret-admin-key");
        expect(authorizedRes.status).toBe(200);
      } finally {
        delete process.env.ADMIN_API_KEY;
      }
    });
  });
});
