import {
  outboxRepository,
  type DeadLetterQueryOptions,
  type DeadLetterQueryResult,
} from "./outbox.repository.js";
import { logger } from "../../config/logger.js";
import type { OutboxEvent } from "@prisma/client";

export const outboxService = {
  /**
   * Retrieves a paginated list of dead-lettered outbox events.
   */
  async getDeadLetterEvents(
    options?: DeadLetterQueryOptions,
  ): Promise<{ data: OutboxEvent[]; pagination: Omit<DeadLetterQueryResult, "events"> }> {
    const { events, total, page, limit, totalPages } =
      await outboxRepository.findDeadLetterEvents(options);

    return {
      data: events,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  },

  /**
   * Retrieves a single dead-letter event by ID.
   */
  async getDeadLetterById(id: string): Promise<OutboxEvent> {
    const event = await outboxRepository.findDeadLetterById(id);
    if (!event) {
      throw new Error("Dead-letter event not found");
    }
    return event;
  },

  /**
   * Safely queues a dead-letter event for replay by resetting its status to PENDING.
   *
   * Safety Model:
   * - Validates that the event exists and is currently in DEAD_LETTER status.
   * - Does NOT synchronously invoke downstream publishers (which could block HTTP requests).
   * - Resets attempts to 0 and schedules nextAttemptAt = now, allowing the background runner
   *   to process it normally under distributed advisory lock coordination.
   */
  async replayDeadLetterEvent(id: string): Promise<OutboxEvent> {
    const existing = await outboxRepository.findDeadLetterById(id);
    if (!existing) {
      throw new Error("Dead-letter event not found");
    }

    const replayed = await outboxRepository.replayDeadLetterEvent(id);

    logger.info(
      {
        eventId: replayed.id,
        eventType: replayed.eventType,
        aggregateId: replayed.aggregateId,
      },
      "Admin manually queued dead-letter event for outbox replay",
    );

    return replayed;
  },
};
