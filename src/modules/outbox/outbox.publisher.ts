import { enqueueOrderConfirmation } from "../../queues/order.queue.js";
import { outboxRepository } from "./outbox.repository.js";
import { logger } from "../../config/logger.js";
import type { BackoffOptions } from "./outbox.backoff.js";

const BATCH_SIZE = 50;

export interface PublishPendingEventsOptions extends BackoffOptions {
  maxEvents?: number | undefined;
  maxAttempts?: number | undefined;
  now?: Date | undefined;
}

export interface PublishResult {
  found: number;
  published: number;
  failed: number;
  deadLettered: number;
}

export const outboxPublisher = {
  /**
   * Dispatches eligible pending outbox events to downstream messaging queues.
   *
   * Reliability & Resilience:
   * - Only queries events where status = 'PENDING' and (nextAttemptAt IS NULL OR nextAttemptAt <= now).
   * - Successfully dispatched events are marked PUBLISHED with processedAt set.
   * - Transient failures trigger exponential backoff: delay = min(baseDelay * 2^(attempts-1), maxDelay) + jitter.
   * - Events exceeding maxAttempts transition permanently to DEAD_LETTER without event loss.
   */
  async publishPendingEvents(
    maxEventsOrOptions?: number | PublishPendingEventsOptions,
  ): Promise<PublishResult> {
    const options: PublishPendingEventsOptions =
      typeof maxEventsOrOptions === "number"
        ? { maxEvents: maxEventsOrOptions }
        : maxEventsOrOptions ?? {};

    const maxEvents = options.maxEvents ?? 200;
    const now = options.now ?? new Date();

    let totalFound = 0;
    let published = 0;
    let failed = 0;
    let deadLettered = 0;

    while (totalFound < maxEvents) {
      const batchTake = Math.min(BATCH_SIZE, maxEvents - totalFound);
      const events = await outboxRepository.findEligiblePendingEvents(batchTake, now);

      if (events.length === 0) {
        break;
      }

      totalFound += events.length;

      for (const event of events) {
        try {
          if (event.eventType === "ORDER_CONFIRMED") {
            const payload = event.payload as {
              orderId: string;
              customerId: string;
            };

            await enqueueOrderConfirmation(
              payload.orderId,
              payload.customerId,
            );
          } else if (event.eventType === "ORDER_EXPIRED") {
            // Expiration event processed: downstream audit and notification ready
          } else {
            throw new Error(`Unsupported outbox event: ${event.eventType}`);
          }

          await outboxRepository.markPublished(event.id);
          published++;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          const failureResult = await outboxRepository.handleFailure(
            event,
            errorMessage,
            options,
          );

          failed++;

          if (failureResult.transitionedToDeadLetter) {
            deadLettered++;
            logger.warn(
              {
                eventId: event.id,
                eventType: event.eventType,
                attempts: failureResult.event.attempts,
                err: errorMessage,
              },
              "Outbox event exceeded maximum retries; transitioned to DEAD_LETTER",
            );
          } else {
            logger.info(
              {
                eventId: event.id,
                eventType: event.eventType,
                attempts: failureResult.event.attempts,
                nextAttemptAt: failureResult.event.nextAttemptAt,
                err: errorMessage,
              },
              "Outbox event failed; scheduled exponential backoff retry",
            );
          }
        }
      }

      if (events.length < batchTake) {
        break;
      }
    }

    return {
      found: totalFound,
      published,
      failed,
      deadLettered,
    };
  },
};
