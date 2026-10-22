
import { Worker } from "bullmq";
import {
  connection,
  type OrderConfirmedJob,
} from "../queues/order.queue.js";
import prisma from "../config/database.js";

const worker = new Worker<OrderConfirmedJob>(
  "order-events",
  async (job) => {
    if (job.name !== "order-confirmed") {
      throw new Error(`Unsupported job type: ${job.name}`);
    }

    const { orderId, customerId } = job.data;
    const eventId = `order-confirmed-${orderId}`;

    try {
      await prisma.processedEvent.create({
        data: { eventId },
      });
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        console.log(`Skipping duplicate event: ${eventId}`);
        return { success: true, orderId, duplicate: true };
      }

      throw error;
    }

    // Simulated notification. Replace with a real provider later.
    console.log("Order confirmation processed", {
      orderId,
      customerId,
      jobId: job.id,
    });

    return { success: true, orderId, duplicate: false };
  },
  {
    connection,
    concurrency: 5,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed:`, error.message);
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("Shutting down order worker...");

  try {
    await worker.close();
    await connection.quit();
    await prisma.$disconnect();
  } catch (error) {
    console.error("Worker shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
