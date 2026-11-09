import { Queue } from "bullmq";
import { connection } from "./order.queue.js";
import { logger } from "../config/logger.js";

export { connection };

export interface WebhookDeliveryJobData {
  deliveryId: string;
}

export const webhookQueue = new Queue<WebhookDeliveryJobData, any, string>(
  "webhook-delivery",
  {
    connection,
    defaultJobOptions: {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  },
);

export async function enqueueWebhookDelivery(
  deliveryId: string,
  delayMs?: number,
): Promise<void> {
  try {
    await webhookQueue.add(
      "deliver",
      { deliveryId },
      {
        ...(delayMs && delayMs > 0 ? { delay: delayMs } : {}),
      },
    );
  } catch (error) {
    logger.error(
      { err: error, deliveryId, delayMs },
      "Failed to enqueue webhook delivery job into BullMQ",
    );
  }
}
