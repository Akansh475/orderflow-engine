
import { outboxPublisher } from "./outbox.publisher.js";

const INTERVAL_MS = 2000;
let running = false;

async function processOutbox(): Promise<void> {
  if (running) return;

  running = true;

  try {
    const result = await outboxPublisher.publishPendingEvents();

    if (result.found > 0) {
      console.log("Outbox batch processed:", result);
    }
  } catch (error) {
    console.error("Outbox processing failed:", error);
  } finally {
    running = false;
  }
}

const timer = setInterval(() => {
  void processOutbox();
}, INTERVAL_MS);

void processOutbox();

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await processOutbox();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
