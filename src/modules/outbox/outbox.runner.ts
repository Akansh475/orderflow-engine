import { outboxPublisher } from "./outbox.publisher.js";
import {
  ADVISORY_LOCK_IDS,
  PostgresAdvisoryLock,
} from "../../shared/advisory-lock.js";
import { logger } from "../../config/logger.js";
import prisma from "../../config/database.js";

const INTERVAL_MS = 2000;
let running = false;
let shuttingDown = false;

export const outboxLock = new PostgresAdvisoryLock({
  lockId: ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER,
  name: "outbox-publisher",
});

export async function processOutbox(): Promise<{ executed: boolean; found?: number }> {
  if (running || shuttingDown) {
    return { executed: false };
  }

  running = true;

  try {
    const lockResult = await outboxLock.withLock(async () => {
      const result = await outboxPublisher.publishPendingEvents();

      if (result.found > 0) {
        console.log("Outbox batch processed:", result);
      }

      return result;
    });

    if (!lockResult.acquired) {
      logger.info(
        { lockId: ADVISORY_LOCK_IDS.OUTBOX_PUBLISHER },
        "Outbox publisher advisory lock held by another worker instance; skipping cycle",
      );
      return { executed: false };
    }

    return { executed: true, found: lockResult.result?.found ?? 0 };
  } catch (error) {
    console.error("Outbox processing failed:", error);
    return { executed: false };
  } finally {
    running = false;
  }
}

const timer = setInterval(() => {
  void processOutbox();
}, INTERVAL_MS);

void processOutbox();

export async function shutdown(signal = "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutting down outbox publisher runner...");
  clearInterval(timer);

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    await outboxLock.disconnect();
    await prisma.$disconnect();
    logger.info("Outbox publisher runner shut down cleanly");
  } catch (error) {
    logger.error({ err: error }, "Error during outbox runner shutdown");
  }

  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
