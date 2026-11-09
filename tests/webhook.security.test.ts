import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";
import {
  isPrivateIp,
  validateWebhookDestination,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../src/modules/webhooks/webhook.security.js";

const prisma = new PrismaClient();

describe("Webhook Security, SSRF Guard & HMAC Signatures", () => {
  const prefix = `sec-test-${Date.now()}`;

  afterAll(async () => {
    delete process.env.ADMIN_API_KEY;
    await prisma.webhookSubscription.deleteMany({
      where: { name: { startsWith: prefix } },
    });
    await prisma.$disconnect();
  });

  describe("1. SSRF IP & Destination Guard", () => {
    it("should identify private and loopback IPv4 addresses as private", () => {
      expect(isPrivateIp("127.0.0.1")).toBe(true);
      expect(isPrivateIp("127.1.2.3")).toBe(true);
      expect(isPrivateIp("10.0.0.1")).toBe(true);
      expect(isPrivateIp("10.255.255.255")).toBe(true);
      expect(isPrivateIp("172.16.0.1")).toBe(true);
      expect(isPrivateIp("172.31.255.255")).toBe(true);
      expect(isPrivateIp("192.168.1.1")).toBe(true);
      expect(isPrivateIp("169.254.169.254")).toBe(true); // AWS/cloud metadata
      expect(isPrivateIp("0.0.0.0")).toBe(true);
      expect(isPrivateIp("100.64.0.1")).toBe(true); // CGNAT
      expect(isPrivateIp("224.0.0.1")).toBe(true); // Multicast
      expect(isPrivateIp("240.0.0.1")).toBe(true); // Reserved
    });

    it("should identify private and loopback IPv6 addresses as private", () => {
      expect(isPrivateIp("::1")).toBe(true);
      expect(isPrivateIp("::")).toBe(true);
      expect(isPrivateIp("fe80::1")).toBe(true);
      expect(isPrivateIp("fc00::1")).toBe(true);
      expect(isPrivateIp("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped
      expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    });

    it("should allow valid public IP addresses", () => {
      expect(isPrivateIp("8.8.8.8")).toBe(false);
      expect(isPrivateIp("1.1.1.1")).toBe(false);
      expect(isPrivateIp("93.184.216.34")).toBe(false);
    });

    it("should block loopback and cloud metadata destinations in validateWebhookDestination", async () => {
      const localhostRes = await validateWebhookDestination("http://localhost:8080/webhook", false);
      expect(localhostRes.safe).toBe(false);
      expect(localhostRes.reason).toContain("SSRF");

      const ip127Res = await validateWebhookDestination("http://127.0.0.1:5000/webhook", false);
      expect(ip127Res.safe).toBe(false);
      expect(ip127Res.reason).toContain("SSRF");

      const metadataRes = await validateWebhookDestination("http://169.254.169.254/latest/meta-data", false);
      expect(metadataRes.safe).toBe(false);
      expect(metadataRes.reason).toContain("SSRF");

      const privateNetRes = await validateWebhookDestination("http://10.0.0.1:3000/hook", false);
      expect(privateNetRes.safe).toBe(false);
      expect(privateNetRes.reason).toContain("SSRF");
    });

    it("should reject non-HTTP/HTTPS protocols and invalid URLs", async () => {
      const ftpRes = await validateWebhookDestination("ftp://example.com/hook", false);
      expect(ftpRes.safe).toBe(false);
      expect(ftpRes.reason).toContain("Unsupported protocol");

      const fileRes = await validateWebhookDestination("file:///etc/passwd", false);
      expect(fileRes.safe).toBe(false);

      const invalidRes = await validateWebhookDestination("not-a-valid-url", false);
      expect(invalidRes.safe).toBe(false);
    });

    it("should allow local destinations when allowLocalOverride is true", async () => {
      const allowedLocal = await validateWebhookDestination("http://127.0.0.1:4000/webhook", true);
      expect(allowedLocal.safe).toBe(true);
    });
  });

  describe("2. HMAC-SHA256 Payload Signing & Verification", () => {
    const secret = "test-secret-key-1234567890abcdef";
    const samplePayload = {
      version: "v1",
      id: "whd_test123",
      notificationType: "OUTBOX_DEAD_LETTER",
      outboxEventId: "evt_123",
      eventType: "ORDER_CREATED",
      failureReason: "Downstream service unavailable",
      attempts: 5,
      deadLetteredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    it("should generate a well-formed signature header with timestamp and v1 hash", () => {
      const now = Date.now();
      const { signatureHeader, timestamp, signature } = signWebhookPayload(secret, samplePayload, now);

      expect(timestamp).toBe(now);
      expect(signatureHeader).toBe(`t=${now},v1=${signature}`);
      expect(signature).toHaveLength(64); // 32-byte hex
    });

    it("should successfully verify a valid signature within tolerance window", () => {
      const now = Date.now();
      const { signatureHeader } = signWebhookPayload(secret, samplePayload, now);

      const verification = verifyWebhookSignature(secret, samplePayload, signatureHeader, 60000);
      expect(verification.valid).toBe(true);
      expect(verification.reason).toBeUndefined();
    });

    it("should reject verification if payload was tampered with", () => {
      const { signatureHeader } = signWebhookPayload(secret, samplePayload);
      const tamperedPayload = { ...samplePayload, attempts: 99 };

      const verification = verifyWebhookSignature(secret, tamperedPayload, signatureHeader);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("mismatch");
    });

    it("should reject verification if secret does not match", () => {
      const { signatureHeader } = signWebhookPayload(secret, samplePayload);
      const wrongSecret = "wrong-secret-key-abcdef1234567890";

      const verification = verifyWebhookSignature(wrongSecret, samplePayload, signatureHeader);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("mismatch");
    });

    it("should reject verification if timestamp is outside tolerance window", () => {
      const tenMinutesAgo = Date.now() - 600000;
      const { signatureHeader } = signWebhookPayload(secret, samplePayload, tenMinutesAgo);

      const verification = verifyWebhookSignature(secret, samplePayload, signatureHeader, 300000); // 5 min tolerance
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("tolerance");
    });

    it("should reject malformed signature headers", () => {
      expect(verifyWebhookSignature(secret, samplePayload, "").valid).toBe(false);
      expect(verifyWebhookSignature(secret, samplePayload, "invalid-header").valid).toBe(false);
      expect(verifyWebhookSignature(secret, samplePayload, "t=invalid,v1=123").valid).toBe(false);
    });
  });

  describe("3. Webhook Registration API & Secret Protection", () => {
    it("should create webhook subscription and mask the secret in the response", async () => {
      const res = await request(app)
        .post("/admin/webhooks")
        .send({
          name: `${prefix}-webhook-1`,
          url: "https://example.com/alerts",
          description: "Production alerts endpoint",
          eventTypes: ["OUTBOX_DEAD_LETTER", "ORDER_CREATED"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe(`${prefix}-webhook-1`);
      expect(res.body.data.url).toBe("https://example.com/alerts");
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.eventTypes).toEqual(["OUTBOX_DEAD_LETTER", "ORDER_CREATED"]);

      // Secret must NEVER be returned in plaintext
      expect(res.body.data.secret).toBeUndefined();
      expect(res.body.data.secretMasked).toMatch(/^••••••••/);
    });

    it("should mask secret when custom secret is supplied upon creation", async () => {
      const customSecret = "super-secret-endpoint-token-123456";
      const res = await request(app)
        .post("/admin/webhooks")
        .send({
          name: `${prefix}-webhook-custom-sec`,
          url: "https://example.com/custom",
          secret: customSecret,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.secret).toBeUndefined();
      expect(res.body.data.secretMasked).toBe(`••••••••${customSecret.slice(-4)}`);
    });

    it("should reject creation with invalid URL or short secret", async () => {
      const resInvalidUrl = await request(app)
        .post("/admin/webhooks")
        .send({
          url: "not-a-valid-url",
        });
      expect(resInvalidUrl.status).toBe(400);

      const resShortSecret = await request(app)
        .post("/admin/webhooks")
        .send({
          url: "https://example.com/valid",
          secret: "too-short",
        });
      expect(resShortSecret.status).toBe(400);
    });

    it("should list subscriptions with secrets masked", async () => {
      const res = await request(app).get("/admin/webhooks");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();

      for (const item of res.body.data) {
        expect(item.secret).toBeUndefined();
        expect(item.secretMasked).toBeDefined();
      }
    });

    it("should retrieve a single subscription with masked secret", async () => {
      const created = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-single`,
          url: "https://example.com/single",
          secret: "plain-secret-in-db-1234567890",
        },
      });

      const res = await request(app).get(`/admin/webhooks/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(created.id);
      expect(res.body.data.secret).toBeUndefined();
      expect(res.body.data.secretMasked).toBe("••••••••7890");
    });

    it("should return 404 for non-existent webhook subscription", async () => {
      const res = await request(app).get("/admin/webhooks/non-existent-sub-id");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WEBHOOK_NOT_FOUND");
    });

    it("should update subscription attributes (activate/deactivate, change URL)", async () => {
      const created = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-update`,
          url: "https://example.com/original",
          secret: "plain-secret-in-db-1234567890",
          isActive: true,
        },
      });

      const res = await request(app)
        .patch(`/admin/webhooks/${created.id}`)
        .send({
          isActive: false,
          url: "https://example.com/updated",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
      expect(res.body.data.url).toBe("https://example.com/updated");
      expect(res.body.data.secret).toBeUndefined();
    });

    it("should delete a webhook subscription", async () => {
      const created = await prisma.webhookSubscription.create({
        data: {
          name: `${prefix}-to-delete`,
          url: "https://example.com/delete-me",
          secret: "secret-to-delete-1234567890",
        },
      });

      const res = await request(app).delete(`/admin/webhooks/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toContain("deleted successfully");

      const check = await prisma.webhookSubscription.findUnique({
        where: { id: created.id },
      });
      expect(check).toBeNull();
    });

    it("should enforce admin authentication when ADMIN_API_KEY is configured", async () => {
      process.env.ADMIN_API_KEY = "test-admin-secret-key";

      try {
        const noAuth = await request(app).get("/admin/webhooks");
        expect(noAuth.status).toBe(401);

        const wrongAuth = await request(app)
          .get("/admin/webhooks")
          .set("x-admin-key", "wrong-key");
        expect(wrongAuth.status).toBe(401);

        const validAuth = await request(app)
          .get("/admin/webhooks")
          .set("x-admin-key", "test-admin-secret-key");
        expect(validAuth.status).toBe(200);
      } finally {
        delete process.env.ADMIN_API_KEY;
      }
    });
  });
});
