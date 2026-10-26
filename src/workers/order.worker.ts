
import { Worker } from "bullmq";
import {
  connection,
  type OrderConfirmedJob,
  type OrderExpiredJob,
  type OrderJobData,
} from "../queues/order.queue.js";
import prisma from "../config/database.js";
import { orderRepository } from "../modules/orders/order.repository.js";

const worker = new Worker<OrderJobData>(
  "order-events",
  async (job) => {
    if (job.name === "order-confirmed") {
      const { orderId, customerId } = job.data as OrderConfirmedJob;
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
    }

    if (job.name === "order-expiration") {
      const { orderId } = job.data as OrderExpiredJob;
      const eventId = `order-expiration-${orderId}`;

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

      try {
        const expiredOrder = await orderRepository.expireOrder(orderId);
        console.log("Order reservation expired", {
          orderId,
          status: expiredOrder?.status,
          jobId: job.id,
        });

        return { success: true, orderId, expired: true, duplicate: false };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "Order is not eligible for expiration" ||
            error.message === "Order not found")
        ) {
          console.log(
            `Order ${orderId} is no longer pending or eligible for expiration; skipping`,
          );
          return { success: true, orderId, expired: false, duplicate: false };
        }

        throw error;
      }
    }

    throw new Error(`Unsupported job type: ${job.name}`);
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
