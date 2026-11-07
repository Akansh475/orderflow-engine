import prisma from "../../config/database.js";
import {
  type WebhookSubscription,
  type WebhookDelivery,
  type Prisma,
  type WebhookDeliveryStatus,
} from "@prisma/client";

export interface WebhookListOptions {
  page?: number | undefined;
  limit?: number | undefined;
  isActive?: boolean | undefined;
}

export interface WebhookListResult {
  webhooks: WebhookSubscription[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DeliveryListOptions {
  page?: number | undefined;
  limit?: number | undefined;
  status?: WebhookDeliveryStatus | undefined;
  webhookId?: string | undefined;
  outboxEventId?: string | undefined;
}

export interface DeliveryListResult {
  deliveries: (WebhookDelivery & { webhook: { id: string; name: string | null; url: string } })[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const webhookRepository = {
  /**
   * Creates a new webhook subscription.
   */
  async createSubscription(data: {
    url: string;
    secret: string;
    name?: string | undefined;
    description?: string | undefined;
    isActive?: boolean | undefined;
    eventTypes?: string[] | undefined;
  }): Promise<WebhookSubscription> {
    return prisma.webhookSubscription.create({
      data: {
        url: data.url,
        secret: data.secret,
        name: data.name ?? null,
        description: data.description ?? null,
        isActive: data.isActive ?? true,
        eventTypes: data.eventTypes ?? ["OUTBOX_DEAD_LETTER"],
      },
    });
  },

  /**
   * Finds a webhook subscription by ID.
   */
  async findSubscriptionById(id: string): Promise<WebhookSubscription | null> {
    return prisma.webhookSubscription.findUnique({
      where: { id },
    });
  },

  /**
   * Lists webhook subscriptions with pagination and optional active status filter.
   */
  async listSubscriptions(options: WebhookListOptions = {}): Promise<WebhookListResult> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20;
    const skip = (page - 1) * limit;

    const where: Prisma.WebhookSubscriptionWhereInput = {};
    if (options.isActive !== undefined) {
      where.isActive = options.isActive;
    }

    const [total, webhooks] = await Promise.all([
      prisma.webhookSubscription.count({ where }),
      prisma.webhookSubscription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      webhooks,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  },

  /**
   * Updates an existing webhook subscription.
   */
  async updateSubscription(
    id: string,
    data: Prisma.WebhookSubscriptionUpdateInput,
  ): Promise<WebhookSubscription> {
    return prisma.webhookSubscription.update({
      where: { id },
      data,
    });
  },

  /**
   * Deletes a webhook subscription and cascades to its deliveries.
   */
  async deleteSubscription(id: string): Promise<WebhookSubscription> {
    return prisma.webhookSubscription.delete({
      where: { id },
    });
  },

  /**
   * Finds active webhook subscriptions subscribed to a specific event type or wildcard.
   */
  async findActiveSubscribersForEvent(
    eventType: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WebhookSubscription[]> {
    const client = tx ?? prisma;
    return client.webhookSubscription.findMany({
      where: {
        isActive: true,
        eventTypes: {
          hasSome: [eventType, "OUTBOX_DEAD_LETTER", "*"],
        },
      },
    });
  },

  /**
   * Inserts a webhook delivery record.
   * If a delivery already exists for the same [webhookId, outboxEventId], it is ignored (idempotent).
   */
  async createDeliveryIdempotent(
    data: {
      webhookId: string;
      outboxEventId: string;
      eventType: string;
      payload: Prisma.InputJsonValue;
      maxAttempts?: number;
      nextAttemptAt?: Date;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WebhookDelivery | null> {
    const client = tx ?? prisma;
    try {
      return await client.webhookDelivery.create({
        data: {
          webhookId: data.webhookId,
          outboxEventId: data.outboxEventId,
          eventType: data.eventType,
          payload: data.payload,
          maxAttempts: data.maxAttempts ?? 5,
          nextAttemptAt: data.nextAttemptAt ?? new Date(),
        },
      });
    } catch (error: any) {
      // Prisma P2002 is Unique constraint failed
      if (error?.code === "P2002") {
        return null;
      }
      throw error;
    }
  },

  /**
   * Finds a delivery record by ID, including its subscription details.
   */
  async findDeliveryById(
    id: string,
  ): Promise<(WebhookDelivery & { webhook: WebhookSubscription }) | null> {
    return prisma.webhookDelivery.findUnique({
      where: { id },
      include: { webhook: true },
    });
  },

  /**
   * Lists webhook deliveries with pagination and optional status / webhookId / outboxEventId filters.
   */
  async listDeliveries(options: DeliveryListOptions = {}): Promise<DeliveryListResult> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20;
    const skip = (page - 1) * limit;

    const where: Prisma.WebhookDeliveryWhereInput = {};
    if (options.status) {
      where.status = options.status;
    }
    if (options.webhookId) {
      where.webhookId = options.webhookId;
    }
    if (options.outboxEventId) {
      where.outboxEventId = options.outboxEventId;
    }

    const [total, deliveries] = await Promise.all([
      prisma.webhookDelivery.count({ where }),
      prisma.webhookDelivery.findMany({
        where,
        include: {
          webhook: {
            select: {
              id: true,
              name: true,
              url: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      deliveries,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  },

  /**
   * Updates a webhook delivery record.
   */
  async updateDelivery(
    id: string,
    data: Prisma.WebhookDeliveryUpdateInput,
  ): Promise<WebhookDelivery> {
    return prisma.webhookDelivery.update({
      where: { id },
      data,
    });
  },
};
