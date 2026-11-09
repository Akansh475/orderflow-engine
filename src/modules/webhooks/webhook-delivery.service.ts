import { webhookRepository } from "./webhook.repository.js";
import { validateWebhookDestination, signWebhookPayload } from "./webhook.security.js";
import { enqueueWebhookDelivery } from "../../queues/webhook.queue.js";
import {
  getWebhookHttpTimeoutMs,
  getWebhookRetryBaseDelayMs,
  getWebhookRetryMaxDelayMs,
} from "../../config/env.js";
import { WebhookDeliveryStatus } from "@prisma/client";
import { logger } from "../../config/logger.js";

export interface DeliveryResult {
  success: boolean;
  shouldRetry: boolean;
  statusCode?: number | undefined;
  error?: string | undefined;
}

export const webhookDeliveryService = {
  /**
   * Processes a single webhook delivery attempt with SSRF protection, HMAC signing,
   * exponential backoff, and non-blocking retry dispatch.
   */
  async processDelivery(deliveryId: string): Promise<DeliveryResult> {
    const delivery = await webhookRepository.findDeliveryById(deliveryId);
    if (!delivery) {
      logger.warn({ deliveryId }, "Webhook delivery record not found; aborting");
      return { success: false, shouldRetry: false, error: "Delivery not found" };
    }

    // If already delivered, avoid duplicate processing
    if (delivery.status === WebhookDeliveryStatus.SUCCESS) {
      logger.info({ deliveryId }, "Webhook delivery already marked as SUCCESS; skipping");
      return { success: true, shouldRetry: false };
    }

    // Verify parent subscription is active
    if (!delivery.webhook.isActive) {
      logger.warn(
        { deliveryId, webhookId: delivery.webhookId },
        "Webhook destination is inactive; marking delivery as FAILED",
      );
      await webhookRepository.updateDelivery(deliveryId, {
        status: WebhookDeliveryStatus.FAILED,
        error: "Webhook destination is deactivated",
        nextAttemptAt: null,
      });
      return { success: false, shouldRetry: false, error: "Subscription is inactive" };
    }

    // SSRF Destination Validation
    const validation = await validateWebhookDestination(delivery.webhook.url);
    if (!validation.safe) {
      const reason = validation.reason || "Destination failed SSRF validation";
      logger.error(
        { deliveryId, url: delivery.webhook.url, reason },
        "Webhook destination rejected by SSRF guard",
      );
      await webhookRepository.updateDelivery(deliveryId, {
        status: WebhookDeliveryStatus.FAILED,
        error: reason,
        nextAttemptAt: null,
        durationMs: 0,
      });
      return { success: false, shouldRetry: false, error: reason };
    }

    // Sign payload
    const timestamp = Date.now();
    const { signatureHeader } = signWebhookPayload(
      delivery.webhook.secret,
      delivery.payload,
      timestamp,
    );

    const timeoutMs = getWebhookHttpTimeoutMs();
    const startTime = Date.now();
    const nextAttempts = delivery.attempts + 1;
    const maxAttempts = delivery.maxAttempts;

    try {
      const response = await fetch(delivery.webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OrderFlow-Engine-Webhook/1.0",
          "x-orderflow-signature": signatureHeader,
          "x-orderflow-timestamp": String(timestamp),
          "x-orderflow-event": delivery.eventType,
          "x-orderflow-delivery-id": delivery.id,
        },
        body: JSON.stringify(delivery.payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error", // Prevent following redirects to unvalidated destinations
      });

      const durationMs = Date.now() - startTime;
      let responseBody = "";
      try {
        const text = await response.text();
        responseBody = text.slice(0, 1000); // Limit stored response body
      } catch {
        // Ignore response body read error
      }

      // Successful HTTP response (2xx)
      if (response.ok) {
        await webhookRepository.updateDelivery(deliveryId, {
          status: WebhookDeliveryStatus.SUCCESS,
          attempts: { increment: 1 },
          statusCode: response.status,
          responseBody,
          durationMs,
          deliveredAt: new Date(),
          error: null,
          nextAttemptAt: null,
        });

        logger.info(
          { deliveryId, webhookId: delivery.webhookId, statusCode: response.status, durationMs },
          "Webhook delivery succeeded",
        );

        return { success: true, shouldRetry: false, statusCode: response.status };
      }

      // Transient errors: 429 (Rate Limit) or 5xx (Server Error)
      const isTransient =
        response.status === 429 || (response.status >= 500 && response.status <= 599);

      if (isTransient) {
        if (nextAttempts >= maxAttempts) {
          const errorMsg = `Max retry attempts (${maxAttempts}) reached. HTTP ${response.status}: ${response.statusText}`;
          await webhookRepository.updateDelivery(deliveryId, {
            status: WebhookDeliveryStatus.FAILED,
            attempts: { increment: 1 },
            statusCode: response.status,
            responseBody,
            durationMs,
            error: errorMsg,
            nextAttemptAt: null,
          });

          logger.warn(
            { deliveryId, attempts: nextAttempts, maxAttempts, statusCode: response.status },
            "Webhook delivery reached max attempts on transient failure; marked FAILED",
          );

          return {
            success: false,
            shouldRetry: false,
            statusCode: response.status,
            error: errorMsg,
          };
        }

        // Calculate exponential backoff
        const baseDelay = getWebhookRetryBaseDelayMs();
        const maxDelay = getWebhookRetryMaxDelayMs();
        const delay = Math.min(baseDelay * Math.pow(2, nextAttempts - 1), maxDelay);
        const nextAttemptAt = new Date(Date.now() + delay);

        await webhookRepository.updateDelivery(deliveryId, {
          status: WebhookDeliveryStatus.PENDING,
          attempts: { increment: 1 },
          statusCode: response.status,
          responseBody,
          durationMs,
          error: `HTTP ${response.status}: ${response.statusText}`,
          nextAttemptAt,
        });

        logger.warn(
          { deliveryId, nextAttempts, delay, statusCode: response.status },
          "Webhook delivery transient failure; scheduled retry with backoff",
        );

        await enqueueWebhookDelivery(deliveryId, delay);
        return {
          success: false,
          shouldRetry: true,
          statusCode: response.status,
          error: response.statusText,
        };
      }

      // Non-retryable permanent client errors: 4xx (except 429)
      const permanentErrorMsg = `Non-retryable client error HTTP ${response.status}: ${response.statusText}`;
      await webhookRepository.updateDelivery(deliveryId, {
        status: WebhookDeliveryStatus.FAILED,
        attempts: { increment: 1 },
        statusCode: response.status,
        responseBody,
        durationMs,
        error: permanentErrorMsg,
        nextAttemptAt: null,
      });

      logger.warn(
        { deliveryId, statusCode: response.status, permanentErrorMsg },
        "Webhook delivery permanently failed due to 4xx client response",
      );

      return {
        success: false,
        shouldRetry: false,
        statusCode: response.status,
        error: permanentErrorMsg,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const isTimeout =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        err?.code === "ETIMEDOUT";

      const failureReason = isTimeout
        ? `Request timed out after ${timeoutMs}ms`
        : err?.message || "Network failure";

      if (nextAttempts >= maxAttempts) {
        const errorMsg = `Max retry attempts (${maxAttempts}) reached. ${failureReason}`;
        await webhookRepository.updateDelivery(deliveryId, {
          status: WebhookDeliveryStatus.FAILED,
          attempts: { increment: 1 },
          durationMs,
          error: errorMsg,
          nextAttemptAt: null,
        });

        logger.warn(
          { deliveryId, attempts: nextAttempts, maxAttempts, err: failureReason },
          "Webhook delivery reached max attempts on network/timeout failure; marked FAILED",
        );

        return {
          success: false,
          shouldRetry: false,
          error: errorMsg,
        };
      }

      // Schedule retry with exponential backoff
      const baseDelay = getWebhookRetryBaseDelayMs();
      const maxDelay = getWebhookRetryMaxDelayMs();
      const delay = Math.min(baseDelay * Math.pow(2, nextAttempts - 1), maxDelay);
      const nextAttemptAt = new Date(Date.now() + delay);

      await webhookRepository.updateDelivery(deliveryId, {
        status: WebhookDeliveryStatus.PENDING,
        attempts: { increment: 1 },
        durationMs,
        error: failureReason,
        nextAttemptAt,
      });

      logger.warn(
        { deliveryId, nextAttempts, delay, err: failureReason },
        "Webhook delivery failed network/timeout; scheduled retry with backoff",
      );

      await enqueueWebhookDelivery(deliveryId, delay);
      return {
        success: false,
        shouldRetry: true,
        error: failureReason,
      };
    }
  },
};
