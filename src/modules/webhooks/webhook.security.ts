import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import type { OutboxEvent } from "@prisma/client";
import { getAllowLocalWebhooks } from "../../config/env.js";

export interface WebhookDeadLetterPayload {
  version: "v1";
  id: string; // unique delivery / notification ID
  notificationType: "OUTBOX_DEAD_LETTER";
  outboxEventId: string;
  eventType: string;
  failureReason: string;
  attempts: number;
  deadLetteredAt: string; // ISO 8601
  createdAt: string; // ISO 8601 (event creation timestamp)
}

/**
 * Checks if a given IP address belongs to private, loopback, link-local, or reserved ranges.
 */
export function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith("::ffff:")) {
    const ipv4 = ip.substring(7);
    if (net.isIPv4(ipv4)) {
      return isPrivateIp(ipv4);
    }
  }

  const family = net.isIP(ip);
  if (family === 0) {
    return false;
  }

  if (family === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
      return true; // Malformed IPv4 treated as unsafe
    }

    const [b0, b1] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;

    // 10.0.0.0/8 (Private-Use Networks)
    if (b0 === 10) return true;

    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;

    // 169.254.0.0/16 (Link-Local / AWS instance metadata)
    if (b0 === 169 && b1 === 254) return true;

    // 172.16.0.0/12 (Private-Use Networks: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true;

    // 192.168.0.0/16 (Private-Use Networks)
    if (b0 === 192 && b1 === 168) return true;

    // 100.64.0.0/10 (Shared Address Space / CGNAT: 100.64.0.0 - 100.127.255.255)
    if (b0 === 100 && b1 !== undefined && b1 >= 64 && b1 <= 127) return true;

    // 192.0.2.0/24 (TEST-NET-1)
    if (b0 === 192 && b1 === 0 && parts[2] === 2) return true;

    // 198.51.100.0/24 (TEST-NET-2)
    if (b0 === 198 && b1 === 51 && parts[2] === 100) return true;

    // 203.0.113.0/24 (TEST-NET-3)
    if (b0 === 203 && b1 === 0 && parts[2] === 113) return true;

    // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
    if (b0 !== undefined && b0 >= 224 && b0 <= 239) return true;

    // 240.0.0.0/4 (Reserved for future use: 240.0.0.0 - 255.255.255.255)
    if (b0 !== undefined && b0 >= 240) return true;

    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();

    // ::1 (IPv6 Loopback)
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;

    // :: (Unspecified address)
    if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

    // fe80::/10 (Link-Local unicast)
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }

    // fc00::/7 (Unique local address: fc00:: - fdff::)
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Validates a destination URL against SSRF and protocol safety requirements.
 */
export async function validateWebhookDestination(
  targetUrl: string,
  allowLocalOverride?: boolean,
): Promise<{ safe: boolean; reason?: string | undefined; resolvedIp?: string | undefined }> {
  const allowLocal = allowLocalOverride ?? getAllowLocalWebhooks();

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { safe: false, reason: "Invalid destination URL" };
  }

  // Protocol check
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      safe: false,
      reason: `Unsupported protocol ${parsed.protocol}; only http: and https: are permitted`,
    };
  }

  // In production, enforce HTTPS
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    return {
      safe: false,
      reason: "HTTPS is required for webhook destinations in production",
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit check for localhost domain
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (!allowLocal) {
      return { safe: false, reason: "Localhost destinations are forbidden (SSRF protection)" };
    }
  }

  // If hostname is directly an IP literal
  if (net.isIP(hostname)) {
    if (!allowLocal && isPrivateIp(hostname)) {
      return {
        safe: false,
        reason: `Target IP ${hostname} is a private or reserved network address (SSRF protection)`,
        resolvedIp: hostname,
      };
    }
    return { safe: true, resolvedIp: hostname };
  }

  // Perform DNS resolution to inspect underlying IPs (prevents DNS rebinding to internal addresses)
  try {
    const lookupResults = await dns.promises.lookup(hostname, { all: true });

    if (!lookupResults || lookupResults.length === 0) {
      return { safe: false, reason: `Could not resolve hostname ${hostname}` };
    }

    for (const record of lookupResults) {
      if (!allowLocal && isPrivateIp(record.address)) {
        return {
          safe: false,
          reason: `Resolved IP ${record.address} for host ${hostname} is private or reserved (SSRF protection)`,
          resolvedIp: record.address,
        };
      }
    }

    return { safe: true, resolvedIp: lookupResults[0]?.address };
  } catch (error: any) {
    return {
      safe: false,
      reason: `DNS lookup failed for destination ${hostname}: ${error?.message || "Unknown error"}`,
    };
  }
}

/**
 * Creates HMAC-SHA256 signature for webhook payload.
 * Signature header format: `t=<timestamp>,v1=<hexSignature>`
 */
export function signWebhookPayload(
  secret: string,
  payload: unknown,
  timestamp: number = Date.now(),
): { signatureHeader: string; timestamp: number; signature: string } {
  const rawPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signedData = `${timestamp}.${rawPayload}`;
  const signature = crypto.createHmac("sha256", secret).update(signedData).digest("hex");

  return {
    signatureHeader: `t=${timestamp},v1=${signature}`,
    timestamp,
    signature,
  };
}

/**
 * Verifies HMAC-SHA256 signature with timestamp replay tolerance.
 */
export function verifyWebhookSignature(
  secret: string,
  payload: unknown,
  signatureHeader: string,
  toleranceMs: number = 300000, // 5 minutes
): { valid: boolean; reason?: string | undefined } {
  if (!signatureHeader) {
    return { valid: false, reason: "Missing signature header" };
  }

  const parts = signatureHeader.split(",");
  let timestampStr: string | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const [key, val] = part.split("=");
    if (key === "t" && val) timestampStr = val;
    if (key === "v1" && val) signature = val;
  }

  if (!timestampStr || !signature) {
    return { valid: false, reason: "Malformed signature header; expected t=...,v1=..." };
  }

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "Invalid timestamp in signature header" };
  }

  if (toleranceMs > 0 && Math.abs(Date.now() - timestamp) > toleranceMs) {
    return { valid: false, reason: "Webhook timestamp outside allowed tolerance window" };
  }

  const rawPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signedData = `${timestamp}.${rawPayload}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedData).digest("hex");

  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (sigBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: "Invalid signature length" };
  }

  const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  if (!isValid) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Constructs a standardized Dead-Letter notification payload.
 */
export function createDeadLetterPayload(
  deliveryId: string,
  outboxEvent: Pick<
    OutboxEvent,
    "id" | "eventType" | "attempts" | "lastError" | "createdAt" | "deadLetteredAt"
  >,
): WebhookDeadLetterPayload {
  return {
    version: "v1",
    id: deliveryId,
    notificationType: "OUTBOX_DEAD_LETTER",
    outboxEventId: outboxEvent.id,
    eventType: outboxEvent.eventType,
    failureReason: outboxEvent.lastError ?? "Unknown failure",
    attempts: outboxEvent.attempts,
    deadLetteredAt:
      outboxEvent.deadLetteredAt?.toISOString() ?? new Date().toISOString(),
    createdAt: outboxEvent.createdAt.toISOString(),
  };
}
