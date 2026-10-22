
import  prisma  from "../../config/database.js";
import { enqueueOrderConfirmation } from "../../queues/order.queue.js";

const BATCH_SIZE = 50;

export const outboxPublisher = {
  async publishPendingEvents() {
    const events = await prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    let published = 0;
    let failed = 0;

    for (const event of events) {
      try {
        if (event.eventType !== "ORDER_CONFIRMED") {
          throw new Error(`Unsupported outbox event: ${event.eventType}`);
        }

        const payload = event.payload as {
          orderId: string;
          customerId: string;
        };

        await enqueueOrderConfirmation(
          payload.orderId,
          payload.customerId,
        );

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

    return {
      found: events.length,
      published,
      failed,
    };
  },
};
