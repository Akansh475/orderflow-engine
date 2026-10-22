
import express from "express";
import prisma from "./config/database.js";
import { logger, httpLogger } from "./config/logger.js";
import productRoutes from "./modules/products/product.routes.js";
import orderRoutes from "./modules/orders/order.routes.js";
import { errorHandler } from "./middleware/error.middleware.js";
import {
  generalRateLimit,
  orderCreationRateLimit,
  paymentRateLimit,
} from "./middleware/rate-limit.middleware.js";

const app = express();

app.use(httpLogger);
app.use(express.json());

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

app.use("/products", generalRateLimit);
app.use("/orders", generalRateLimit);

app.use("/orders", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") {
    return orderCreationRateLimit(req, res, next);
  }

  if (req.method === "POST" && req.path.endsWith("/pay")) {
    return paymentRateLimit(req, res, next);
  }

  next();
});

app.use("/products", productRoutes);
app.use("/orders", orderRoutes);

app.use(errorHandler);

export default app;
