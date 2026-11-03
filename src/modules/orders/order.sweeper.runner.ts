import { logger } from "../../config/logger.js";
import prisma from "../../config/database.js";
import { orderSweeper } from "./order.sweeper.js";

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Received termination signal. Shutting down order reservation sweeper runner...");

  try {
    await orderSweeper.stop();
    await prisma.$disconnect();
    logger.info("Order reservation sweeper runner shut down cleanly");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error occurred during sweeper runner shutdown");
    process.exit(1);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection in order reservation sweeper runner");
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception in order reservation sweeper runner");
  void shutdown("uncaughtException");
});

// Start the periodic sweeper runner
orderSweeper.start();
