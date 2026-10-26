
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export interface OrderConfirmedJob {
  orderId: string;
  customerId: string;
}

export interface OrderExpiredJob {
  orderId: string;
}

export type OrderJobData = OrderConfirmedJob | OrderExpiredJob;

export const orderQueue = new Queue<OrderJobData, any, string>("order-events", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueOrderConfirmation(
  orderId: string,
  customerId: string,
): Promise<void> {
  await orderQueue.add(
    "order-confirmed",
    { orderId, customerId },
    {
      jobId: `order-confirmed-${orderId}`,
    },
  );
}

export async function enqueueOrderExpiration(
  orderId: string,
  delayMs: number,
): Promise<void> {
  await orderQueue.add(
    "order-expiration",
    { orderId },
    {
      delay: delayMs,
      jobId: `order-expiration-${orderId}`,
    },
  );
}
