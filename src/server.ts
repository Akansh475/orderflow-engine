import "dotenv/config";
import app from "./app.js";
import { logger } from "./config/logger.js";

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "OrderFlow Engine started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutting down HTTP server");

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));