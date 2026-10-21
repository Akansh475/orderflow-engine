
import { Worker } from "bullmq";
import {
  connection,
  type OrderConfirmedJob,
} from "../queues/order.queue.js";

const worker = new Worker<OrderConfirmedJob>(
  "order-events",
  async (job) => {
    switch (job.name) {
      case "order-confirmed": {
        const { orderId, customerId } = job.data;

        // Placeholder for a real email or notification provider.
        console.log("Order confirmation processed", {
          orderId,
          customerId,
          jobId: job.id,
        });

        return { success: true, orderId };
      }

      default:
        throw new Error(`Unsupported job type: ${job.name}`);
    }
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

async function shutdown(): Promise<void> {
  console.log("Shutting down order worker...");
  await worker.close();
  await connection.quit();
}

process.once("SIGINT", () => {
  void shutdown().catch(console.error);
});

process.once("SIGTERM", () => {
  void shutdown().catch(console.error);
});
