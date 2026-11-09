import crypto from "node:crypto";
import prisma from "../../config/database.js";
import {
  type OutboxEvent,
  type Prisma,
  OutboxStatus,
  WebhookDeliveryStatus,
} from "@prisma/client";
import {
  calculateNextAttemptAt,
  isMaxAttemptsReached,
  type BackoffOptions,
} from "./outbox.backoff.js";
import { getWebhookMaxAttempts } from "../../config/env.js";
import { createDeadLetterPayload } from "../webhooks/webhook.security.js";
import { enqueueWebhookDelivery } from "../../queues/webhook.queue.js";
import { logger } from "../../config/logger.js";

export interface DeadLetterQueryOptions {
  page?: number | undefined;
  limit?: number | undefined;
  eventType?: string | undefined;
}

export interface DeadLetterQueryResult {
  events: OutboxEvent[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const outboxRepository = {
  /**
   * Finds pending events that are eligible for publishing:
   * - status = PENDING and processedAt IS NULL
   * - nextAttemptAt IS NULL (never failed) OR nextAttemptAt <= now (backoff window elapsed)
   * - ordered by createdAt ascending
   */
  async findEligiblePendingEvents(
    batchTake: number,
    now = new Date(),
  ): Promise<OutboxEvent[]> {
    return prisma.outboxEvent.findMany({
      where: {
        status: OutboxStatus.PENDING,
        processedAt: null,
        OR: [
          { nextAttemptAt: null },
          { nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: batchTake,
    });
  },

  /**
   * Marks an outbox event as successfully PUBLISHED.
   * Clears nextAttemptAt and increments attempts.
   */
  async markPublished(id: string): Promise<OutboxEvent> {
    return prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.PUBLISHED,
        processedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
        nextAttemptAt: null,
      },
    });
  },

  /**
   * Handles an outbox delivery failure:
   * - If attempt count has reached maxAttempts: transitions to DEAD_LETTER.
   * - Otherwise: calculates exponential backoff and schedules nextAttemptAt.
   */
  async handleFailure(
    event: Pick<OutboxEvent, "id" | "attempts">,
    errorMessage: string,
    options?: BackoffOptions & { maxAttempts?: number | undefined },
  ): Promise<{ event: OutboxEvent; transitionedToDeadLetter: boolean }> {
    const nextAttemptsCount = event.attempts + 1;
    const reachedMax = isMaxAttemptsReached(nextAttemptsCount, options?.maxAttempts);

    if (reachedMax) {
      const { deadLetterEvent, deliveriesToEnqueue } = await prisma.$transaction(async (tx) => {
        const dlEvent = await tx.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.DEAD_LETTER,
            attempts: { increment: 1 },
            lastError: errorMessage,
            nextAttemptAt: null,
            deadLetteredAt: new Date(),
          },
        });

        // Query active webhook destinations interested in this event or wildcard
        const subscriptions = await tx.webhookSubscription.findMany({
          where: {
            isActive: true,
            eventTypes: {
              hasSome: [dlEvent.eventType, "OUTBOX_DEAD_LETTER", "*"],
            },
          },
        });

        const createdDeliveryIds: string[] = [];

        for (const sub of subscriptions) {
          const existing = await tx.webhookDelivery.findUnique({
            where: {
              webhookId_outboxEventId: {
                webhookId: sub.id,
                outboxEventId: dlEvent.id,
              },
            },
          });

          if (!existing) {
            const deliveryId = `whd_${crypto.randomUUID().replace(/-/g, "")}`;
            const payload = createDeadLetterPayload(deliveryId, dlEvent);

            const delivery = await tx.webhookDelivery.create({
              data: {
                id: deliveryId,
                webhookId: sub.id,
                outboxEventId: dlEvent.id,
                eventType: dlEvent.eventType,
                payload: payload as unknown as Prisma.InputJsonValue,
                status: WebhookDeliveryStatus.PENDING,
                attempts: 0,
                maxAttempts: getWebhookMaxAttempts(),
                nextAttemptAt: new Date(),
              },
            });
            createdDeliveryIds.push(delivery.id);
          }
        }

        return { deadLetterEvent: dlEvent, deliveriesToEnqueue: createdDeliveryIds };
      });

      // Asynchronously dispatch notifications outside the database transaction.
      // If BullMQ/Redis is temporarily unavailable, the durable WebhookDelivery
      // records in PostgreSQL remain PENDING and can be recovered.
      for (const deliveryId of deliveriesToEnqueue) {
        try {
          await enqueueWebhookDelivery(deliveryId);
        } catch (enqueueErr) {
          logger.warn(
            { err: enqueueErr, deliveryId },
            "Failed to enqueue webhook delivery job after transaction commit",
          );
        }
      }

      return {
        event: deadLetterEvent,
        transitionedToDeadLetter: true,
      };
    }

    const nextAttemptAt = calculateNextAttemptAt(nextAttemptsCount, options);
    const updatedEvent = await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: OutboxStatus.PENDING,
        attempts: { increment: 1 },
        lastError: errorMessage,
        nextAttemptAt,
      },
    });

    return {
      event: updatedEvent,
      transitionedToDeadLetter: false,
    };
  },

  /**
   * Queries dead-lettered events with pagination and optional eventType filter.
   */
  async findDeadLetterEvents(
    options?: DeadLetterQueryOptions,
  ): Promise<DeadLetterQueryResult> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OutboxEventWhereInput = {
      status: OutboxStatus.DEAD_LETTER,
      ...(options?.eventType ? { eventType: options.eventType } : {}),
    };

    const [events, total] = await Promise.all([
      prisma.outboxEvent.findMany({
        where,
        orderBy: { deadLetteredAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.outboxEvent.count({ where }),
    ]);

    return {
      events,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  },

  /**
   * Retrieves a single dead-letter event by ID.
   */
  async findDeadLetterById(id: string): Promise<OutboxEvent | null> {
    return prisma.outboxEvent.findFirst({
      where: {
        id,
        status: OutboxStatus.DEAD_LETTER,
      },
    });
  },

  /**
   * Safely queues a dead-letter event for replay:
   * - Resets status to PENDING
   * - Resets nextAttemptAt to now (immediately eligible)
   * - Resets attempts to 0
   * - Clears deadLetteredAt
   */
  async replayDeadLetterEvent(id: string): Promise<OutboxEvent> {
    return prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.PENDING,
        nextAttemptAt: new Date(),
        deadLetteredAt: null,
        attempts: 0,
        lastError: null,
      },
    });
  },
};
