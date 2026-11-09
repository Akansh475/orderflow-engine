import { Worker } from "bullmq";
import { connection, type WebhookDeliveryJobData } from "../queues/webhook.queue.js";
import { webhookDeliveryService } from "../modules/webhooks/webhook-delivery.service.js";
import { logger } from "../config/logger.js";

export async function processWebhookJob(job: {
  name: string;
  data: WebhookDeliveryJobData;
  id?: string | undefined;
}) {
  const { deliveryId } = job.data;
  return webhookDeliveryService.processDelivery(deliveryId);
}

export const webhookWorker = new Worker<WebhookDeliveryJobData>(
  "webhook-delivery",
  processWebhookJob,
  {
    connection,
    concurrency: 5,
  },
);

webhookWorker.on("completed", (job) => {
  logger.info(
    { jobId: job.id, deliveryId: job.data?.deliveryId },
    "Webhook delivery job completed",
  );
});

webhookWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, deliveryId: job?.data?.deliveryId, err: error.message },
    "Webhook delivery job failed",
  );
});

let shuttingDown = false;

export async function shutdownWebhookWorker(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutting down webhook worker...");

  try {
    await webhookWorker.close();
  } catch (error) {
    logger.error({ err: error }, "Webhook worker shutdown failed");
  }
}

process.once("SIGINT", () => void shutdownWebhookWorker());
process.once("SIGTERM", () => void shutdownWebhookWorker());
