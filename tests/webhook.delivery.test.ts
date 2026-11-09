import http from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { PrismaClient, OutboxStatus, WebhookDeliveryStatus } from "@prisma/client";
import app from "../src/app.js";
import { outboxRepository } from "../src/modules/outbox/outbox.repository.js";
import { webhookDeliveryService } from "../src/modules/webhooks/webhook-delivery.service.js";
import { webhookRepository } from "../src/modules/webhooks/webhook.repository.js";
import { verifyWebhookSignature } from "../src/modules/webhooks/webhook.security.js";
import * as webhookQueue from "../src/queues/webhook.queue.js";

const prisma = new PrismaClient();

describe("Dead-Letter Alerting, Webhook Notifications & Delivery Lifecycle", () => {
  const prefix = `del-test-${Date.now()}`;
  let mockServer: http.Server;
  let mockServerUrl: string;
  let mockServerPort: number;
  let lastReceivedRequest: {
    headers: http.IncomingHttpHeaders;
    body: any;
  } | null = null;
  let mockServerHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    // Start local test HTTP server to act as a destination endpoint
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        let bodyStr = "";
        req.on("data", (chunk) => {
          bodyStr += chunk;
        });
        req.on("end", () => {
          try {
            lastReceivedRequest = {
              headers: req.headers,
              body: bodyStr ? JSON.parse(bodyStr) : null,
            };
          } catch {
            lastReceivedRequest = {
              headers: req.headers,
              body: bodyStr,
            };
          }

          if (mockServerHandler) {
            mockServerHandler(req, res);
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ received: true }));
          }
        });
      });

      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as AddressInfo;
        mockServerPort = addr.port;
        mockServerUrl = `http://127.0.0.1:${mockServerPort}/webhook-target`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env.ALLOW_LOCAL_WEBHOOKS;
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));

    // Clean up test data
    await prisma.webhookDelivery.deleteMany({
      where: {
        OR: [
          { webhook: { name: { startsWith: prefix } } },
          { outboxEventId: { startsWith: prefix } },
        ],
      },
    });
    await prisma.webhookSubscription.deleteMany({
      where: { name: { startsWith: prefix } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });

    await prisma.$disconnect();
  });

  beforeEach(() => {
    lastReceivedRequest = null;
    process.env.ALLOW_LOCAL_WEBHOOKS = "true"; // Allow test HTTP server
    mockServerHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    };
  });

  describe("1. Durable Dead-Letter Notification Creation", () => {
    it("should atomically create a WebhookDelivery when OutboxEvent transitions to DEAD_LETTER", async () => {
      const enqueueSpy = vi.spyOn(webhookQueue, "enqueueWebhookDelivery").mockResolvedValue();

      // Create an active webhook subscription
      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-1`,
          url: mockServerUrl,
          secret: "secret-for-sub-1-1234567890",
          eventTypes: ["OUTBOX_DEAD_LETTER", "ORDER_CREATED"],
          isActive: true,
        },
      });

      // Create an outbox event that is on its 4th attempt (max = 5)
      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          id: `${prefix}-evt-1`,
          eventType: "ORDER_CREATED",
          aggregateId: `${prefix}-agg-1`,
          payload: { orderId: `${prefix}-agg-1` },
          attempts: 4,
          status: OutboxStatus.PENDING,
        },
      });

      // 5th failure -> reaches max attempts -> transitions to DEAD_LETTER
      const result = await outboxRepository.handleFailure(
        outboxEvent,
        "Simulated downstream failure",
        { maxAttempts: 5 },
      );

      expect(result.transitionedToDeadLetter).toBe(true);
      expect(result.event.status).toBe(OutboxStatus.DEAD_LETTER);
      expect(result.event.deadLetteredAt).not.toBeNull();

      // Verify a WebhookDelivery record was durably inserted in PostgreSQL
      const delivery = await prisma.webhookDelivery.findFirst({
        where: {
          webhookId: sub.id,
          outboxEventId: outboxEvent.id,
        },
      });

      expect(delivery).not.toBeNull();
      expect(delivery?.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(delivery?.attempts).toBe(0);
      expect(delivery?.eventType).toBe("ORDER_CREATED");

      // Verify payload structure and fields
      const payload = delivery?.payload as any;
      expect(payload.version).toBe("v1");
      expect(payload.id).toBe(delivery?.id);
      expect(payload.notificationType).toBe("OUTBOX_DEAD_LETTER");
      expect(payload.outboxEventId).toBe(outboxEvent.id);
      expect(payload.eventType).toBe("ORDER_CREATED");
      expect(payload.failureReason).toBe("Simulated downstream failure");
      expect(payload.attempts).toBe(5);
      expect(payload.deadLetteredAt).toBeDefined();
      expect(payload.createdAt).toBeDefined();

      // Verify BullMQ job was enqueued asynchronously outside the transaction
      expect(enqueueSpy).toHaveBeenCalledWith(delivery?.id);
      enqueueSpy.mockRestore();
    });

    it("should NOT create notifications for inactive subscriptions or non-matching event types", async () => {
      // Inactive subscription
      const inactiveSub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-inactive`,
          url: mockServerUrl,
          secret: "secret-for-inactive-1234567890",
          eventTypes: ["OUTBOX_DEAD_LETTER"],
          isActive: false,
        },
      });

      // Active subscription but different event type
      const otherTypeSub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-other-type`,
          url: mockServerUrl,
          secret: "secret-for-other-type-1234567890",
          eventTypes: ["INVENTORY_ADJUSTED"], // Not matching ORDER_SHIPPED or OUTBOX_DEAD_LETTER
          isActive: true,
        },
      });

      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          id: `${prefix}-evt-unmatched`,
          eventType: "ORDER_SHIPPED",
          aggregateId: `${prefix}-agg-unmatched`,
          payload: { orderId: `${prefix}-agg-unmatched` },
          attempts: 2,
          status: OutboxStatus.PENDING,
        },
      });

      await outboxRepository.handleFailure(outboxEvent, "Permanent failure", { maxAttempts: 3 });

      const inactiveDelivery = await prisma.webhookDelivery.findFirst({
        where: { webhookId: inactiveSub.id, outboxEventId: outboxEvent.id },
      });
      expect(inactiveDelivery).toBeNull();

      const otherDelivery = await prisma.webhookDelivery.findFirst({
        where: { webhookId: otherTypeSub.id, outboxEventId: outboxEvent.id },
      });
      expect(otherDelivery).toBeNull();
    });

    it("should prevent duplicate delivery records when outbox transition is triggered multiple times", async () => {
      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-dup-check`,
          url: mockServerUrl,
          secret: "secret-for-sub-dup-1234567890",
          eventTypes: ["*"],
          isActive: true,
        },
      });

      const outboxEvent = await prisma.outboxEvent.create({
        data: {
          id: `${prefix}-evt-dup-check`,
          eventType: "ORDER_CREATED",
          aggregateId: `${prefix}-agg-dup`,
          payload: { orderId: `${prefix}-agg-dup` },
          attempts: 4,
          status: OutboxStatus.PENDING,
        },
      });

      // First transition
      await outboxRepository.handleFailure(outboxEvent, "Error 1", { maxAttempts: 5 });

      // Simulate a duplicate retry/re-execution of handleFailure on the same event
      await outboxRepository.handleFailure(
        { id: outboxEvent.id, attempts: 4 },
        "Error 2",
        { maxAttempts: 5 },
      );

      const count = await prisma.webhookDelivery.count({
        where: { webhookId: sub.id, outboxEventId: outboxEvent.id },
      });

      expect(count).toBe(1); // Uniqueness constraint prevented duplicate logical delivery
    });
  });

  describe("2. Webhook Delivery Processing & HTTP Dispatch", () => {
    it("should successfully deliver notification, sign request with HMAC, and record SUCCESS in DB", async () => {
      const secret = "delivery-success-secret-1234567890";
      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-success`,
          url: mockServerUrl,
          secret,
          isActive: true,
        },
      });

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-success`,
          eventType: "ORDER_CREATED",
          payload: {
            version: "v1",
            id: `${prefix}-del-success`,
            notificationType: "OUTBOX_DEAD_LETTER",
            outboxEventId: `${prefix}-evt-success`,
            eventType: "ORDER_CREATED",
            failureReason: "Downstream timeout",
            attempts: 5,
            deadLetteredAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
          status: WebhookDeliveryStatus.PENDING,
          attempts: 0,
          maxAttempts: 5,
        },
      });

      const result = await webhookDeliveryService.processDelivery(delivery.id);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);

      // Verify HTTP request arrived at the server
      expect(lastReceivedRequest).not.toBeNull();
      const headers = lastReceivedRequest!.headers;
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-orderflow-event"]).toBe("ORDER_CREATED");
      expect(headers["x-orderflow-delivery-id"]).toBe(delivery.id);

      const signatureHeader = headers["x-orderflow-signature"] as string;
      expect(signatureHeader).toBeDefined();

      // Verify the receiver can cryptographically verify the signature
      const verification = verifyWebhookSignature(
        secret,
        lastReceivedRequest!.body,
        signatureHeader,
      );
      expect(verification.valid).toBe(true);

      // Verify database record was updated to SUCCESS
      const updated = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
      });
      expect(updated?.status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(updated?.statusCode).toBe(200);
      expect(updated?.attempts).toBe(1);
      expect(updated?.deliveredAt).not.toBeNull();
      expect(updated?.error).toBeNull();
      expect(updated?.nextAttemptAt).toBeNull();
      expect(updated?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should retry with exponential backoff on HTTP 500 server error and reschedule nextAttemptAt", async () => {
      const enqueueSpy = vi.spyOn(webhookQueue, "enqueueWebhookDelivery").mockResolvedValue();

      mockServerHandler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      };

      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-500`,
          url: mockServerUrl,
          secret: "secret-500-test-1234567890",
          isActive: true,
        },
      });

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-500`,
          eventType: "ORDER_CREATED",
          payload: { test: true },
          status: WebhookDeliveryStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
        },
      });

      const result = await webhookDeliveryService.processDelivery(delivery.id);
      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(true);

      const afterAttempt = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
      });
      expect(afterAttempt?.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(afterAttempt?.attempts).toBe(1);
      expect(afterAttempt?.statusCode).toBe(500);
      expect(afterAttempt?.nextAttemptAt).not.toBeNull();
      expect(afterAttempt?.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      // Should have enqueued next attempt with delay
      expect(enqueueSpy).toHaveBeenCalled();
      enqueueSpy.mockRestore();
    });

    it("should mark delivery FAILED when maximum attempts are exhausted on transient errors", async () => {
      mockServerHandler = (_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service unavailable" }));
      };

      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-exhausted`,
          url: mockServerUrl,
          secret: "secret-exhausted-test-1234567890",
          isActive: true,
        },
      });

      // Delivery that has already had 2 attempts (max = 3)
      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-exhausted`,
          eventType: "ORDER_CREATED",
          payload: { test: true },
          status: WebhookDeliveryStatus.PENDING,
          attempts: 2,
          maxAttempts: 3,
        },
      });

      const result = await webhookDeliveryService.processDelivery(delivery.id);
      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);

      const finalDelivery = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
      });
      expect(finalDelivery?.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(finalDelivery?.attempts).toBe(3);
      expect(finalDelivery?.statusCode).toBe(503);
      expect(finalDelivery?.error).toContain("Max retry attempts (3) reached");
      expect(finalDelivery?.nextAttemptAt).toBeNull();
    });

    it("should immediately mark delivery FAILED on non-retryable 4xx client errors (e.g. 400 Bad Request)", async () => {
      mockServerHandler = (_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request payload" }));
      };

      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-400`,
          url: mockServerUrl,
          secret: "secret-400-test-1234567890",
          isActive: true,
        },
      });

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-400`,
          eventType: "ORDER_CREATED",
          payload: { test: true },
          status: WebhookDeliveryStatus.PENDING,
          attempts: 0,
          maxAttempts: 5,
        },
      });

      const result = await webhookDeliveryService.processDelivery(delivery.id);
      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false); // Non-retryable!

      const updated = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
      });
      expect(updated?.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(updated?.statusCode).toBe(400);
      expect(updated?.error).toContain("Non-retryable client error");
      expect(updated?.nextAttemptAt).toBeNull();
    });

    it("should reject delivery and mark FAILED if destination violates SSRF policies", async () => {
      delete process.env.ALLOW_LOCAL_WEBHOOKS; // Enforce SSRF blocking

      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-ssrf-blocked`,
          url: "http://127.0.0.1:9999/hook",
          secret: "secret-ssrf-test-1234567890",
          isActive: true,
        },
      });

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-ssrf`,
          eventType: "ORDER_CREATED",
          payload: { test: true },
          status: WebhookDeliveryStatus.PENDING,
        },
      });

      const result = await webhookDeliveryService.processDelivery(delivery.id);
      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.error).toContain("SSRF");

      const updated = await prisma.webhookDelivery.findUnique({
        where: { id: delivery.id },
      });
      expect(updated?.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(updated?.error).toContain("SSRF");
    });
  });

  describe("3. Delivery Inspection & Replay API", () => {
    it("should list deliveries with pagination and status filters", async () => {
      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-history`,
          url: mockServerUrl,
          secret: "secret-history-1234567890",
          isActive: true,
        },
      });

      await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-h1`,
          eventType: "ORDER_CREATED",
          payload: { h: 1 },
          status: WebhookDeliveryStatus.SUCCESS,
        },
      });

      await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-h2`,
          eventType: "ORDER_CREATED",
          payload: { h: 2 },
          status: WebhookDeliveryStatus.FAILED,
        },
      });

      const resAll = await request(app)
        .get("/admin/webhooks/deliveries")
        .query({ webhookId: sub.id });

      expect(resAll.status).toBe(200);
      expect(resAll.body.data.length).toBe(2);
      expect(resAll.body.pagination.total).toBe(2);

      const resSuccess = await request(app)
        .get("/admin/webhooks/deliveries")
        .query({ webhookId: sub.id, status: "SUCCESS" });

      expect(resSuccess.status).toBe(200);
      expect(resSuccess.body.data.length).toBe(1);
      expect(resSuccess.body.data[0].status).toBe("SUCCESS");
    });

    it("should retrieve single delivery details by ID", async () => {
      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-single-del`,
          url: mockServerUrl,
          secret: "secret-single-del-1234567890",
          isActive: true,
        },
      });

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-single-del`,
          eventType: "ORDER_CREATED",
          payload: { message: "test delivery" },
          status: WebhookDeliveryStatus.SUCCESS,
          statusCode: 200,
        },
      });

      const res = await request(app).get(`/admin/webhooks/deliveries/${delivery.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(delivery.id);
      expect(res.body.data.webhook.name).toBe(`${prefix}-sub-single-del`);
    });

    it("should return 404 for non-existent delivery ID", async () => {
      const res = await request(app).get("/admin/webhooks/deliveries/non-existent-del-123");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WEBHOOK_DELIVERY_NOT_FOUND");
    });

    it("should replay a failed delivery by resetting status to PENDING and enqueuing job", async () => {
      const enqueueSpy = vi.spyOn(webhookQueue, "enqueueWebhookDelivery").mockResolvedValue();

      const sub = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-sub-replay`,
          url: mockServerUrl,
          secret: "secret-replay-1234567890",
          isActive: true,
        },
      });

      const failedDelivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: sub.id,
          outboxEventId: `${prefix}-evt-replay`,
          eventType: "ORDER_CREATED",
          payload: { replay: true },
          status: WebhookDeliveryStatus.FAILED,
          attempts: 5,
          error: "Previous connection failure",
        },
      });

      const res = await request(app)
        .post(`/admin/webhooks/deliveries/${failedDelivery.id}/replay`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("queued for replay");
      expect(res.body.data.status).toBe(WebhookDeliveryStatus.PENDING);
      expect(res.body.data.attempts).toBe(0);
      expect(res.body.data.error).toBeNull();

      expect(enqueueSpy).toHaveBeenCalledWith(failedDelivery.id);
      enqueueSpy.mockRestore();
    });
  });
});
