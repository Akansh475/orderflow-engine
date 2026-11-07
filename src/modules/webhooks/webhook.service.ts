import crypto from "node:crypto";
import {
  webhookRepository,
  type WebhookListOptions,
  type WebhookListResult,
} from "./webhook.repository.js";
import {
  type CreateWebhookSubscriptionInput,
  type UpdateWebhookSubscriptionInput,
} from "./webhook.validation.js";
import type { WebhookSubscription } from "@prisma/client";
import { logger } from "../../config/logger.js";

export interface SafeWebhookSubscription {
  id: string;
  name: string | null;
  description: string | null;
  url: string;
  isActive: boolean;
  eventTypes: string[];
  secretMasked: string;
  createdAt: Date;
  updatedAt: Date;
}

export function maskSecret(secret: string): string {
  if (!secret) return "••••••••";
  const tail = secret.slice(-4);
  return `••••••••${tail}`;
}

export function toSafeSubscription(sub: WebhookSubscription): SafeWebhookSubscription {
  return {
    id: sub.id,
    name: sub.name,
    description: sub.description,
    url: sub.url,
    isActive: sub.isActive,
    eventTypes: sub.eventTypes,
    secretMasked: maskSecret(sub.secret),
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

export const webhookService = {
  /**
   * Registers a new webhook subscription destination.
   * Auto-generates a secure 48-character hex secret if not provided.
   * Secrets are never exposed in plaintext in return values.
   */
  async createSubscription(
    input: CreateWebhookSubscriptionInput,
  ): Promise<SafeWebhookSubscription> {
    const secret = input.secret || crypto.randomBytes(24).toString("hex");

    const created = await webhookRepository.createSubscription({
      url: input.url,
      secret,
      name: input.name,
      description: input.description,
      isActive: input.isActive ?? true,
      eventTypes: input.eventTypes ?? ["OUTBOX_DEAD_LETTER"],
    });

    logger.info(
      { webhookId: created.id, url: created.url, eventTypes: created.eventTypes },
      "Registered new webhook subscription destination",
    );

    return toSafeSubscription(created);
  },

  /**
   * Retrieves a single webhook subscription by ID.
   */
  async getSubscriptionById(id: string): Promise<SafeWebhookSubscription> {
    const sub = await webhookRepository.findSubscriptionById(id);
    if (!sub) {
      throw new Error("Webhook subscription not found");
    }
    return toSafeSubscription(sub);
  },

  /**
   * Lists webhook subscriptions with pagination and optional active filter.
   */
  async listSubscriptions(
    options?: WebhookListOptions,
  ): Promise<{ data: SafeWebhookSubscription[]; pagination: Omit<WebhookListResult, "webhooks"> }> {
    const { webhooks, total, page, limit, totalPages } =
      await webhookRepository.listSubscriptions(options);

    return {
      data: webhooks.map(toSafeSubscription),
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  },

  /**
   * Updates an existing webhook subscription.
   */
  async updateSubscription(
    id: string,
    input: UpdateWebhookSubscriptionInput,
  ): Promise<SafeWebhookSubscription> {
    const existing = await webhookRepository.findSubscriptionById(id);
    if (!existing) {
      throw new Error("Webhook subscription not found");
    }

    const updated = await webhookRepository.updateSubscription(id, {
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      ...(input.secret !== undefined ? { secret: input.secret } : {}),
    });

    logger.info({ webhookId: id }, "Updated webhook subscription");
    return toSafeSubscription(updated);
  },

  /**
   * Deletes a webhook subscription.
   */
  async deleteSubscription(id: string): Promise<{ id: string }> {
    const existing = await webhookRepository.findSubscriptionById(id);
    if (!existing) {
      throw new Error("Webhook subscription not found");
    }

    await webhookRepository.deleteSubscription(id);
    logger.info({ webhookId: id }, "Deleted webhook subscription");

    return { id };
  },
};
