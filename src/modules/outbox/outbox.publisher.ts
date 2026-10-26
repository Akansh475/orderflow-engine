
import  prisma  from "../../config/database.js";
import { enqueueOrderConfirmation } from "../../queues/order.queue.js";

const BATCH_SIZE = 50;

export const outboxPublisher = {
  async publishPendingEvents(maxEvents = 200) {
    let totalFound = 0;
    let published = 0;
    let failed = 0;

    while (totalFound < maxEvents) {
      const batchTake = Math.min(BATCH_SIZE, maxEvents - totalFound);
      const events = await prisma.outboxEvent.findMany({
        where: { processedAt: null },
        orderBy: { createdAt: "asc" },
        take: batchTake,
      });

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

          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              processedAt: new Date(),
              attempts: { increment: 1 },
              lastError: null,
            },
          });

          published++;
        } catch (error) {
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              attempts: { increment: 1 },
              lastError:
                error instanceof Error ? error.message : "Unknown error",
            },
          });

          failed++;
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
    };
  },
};
