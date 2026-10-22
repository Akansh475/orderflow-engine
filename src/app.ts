import express from "express";
import prisma from "./config/database.js";
import { logger, httpLogger } from "./config/logger.js";
import productRoutes from "./modules/products/product.routes.js";
import { errorHandler } from "./middleware/error.middleware.js";
import orderRoutes from "./modules/orders/order.routes.js";

const app = express();

app.use(httpLogger);
app.use(express.json());

app.use("/products", productRoutes);
app.use("/orders", orderRoutes);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "orderflow-engine",
  });
});

app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    logger.error({ err: error }, "Database health check failed");

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.use(errorHandler);

export default app;