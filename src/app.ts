import express from "express";
import prisma from "./config/database.js";
import productRoutes from "./modules/products/product.routes.js";
import { errorHandler } from "./middleware/error.middleware.js";
import orderRoutes from "./modules/orders/order.routes.js";

const app = express();

app.use(express.json());

app.use("/products", productRoutes);
app.use("/orders", orderRoutes);

app.use(errorHandler);

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
    console.error("Database health check failed:", error);

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

export default app;
