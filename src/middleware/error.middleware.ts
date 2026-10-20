
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export const errorHandler: ErrorRequestHandler = (
  err,
  _req,
  res,
  _next,
) => {
  console.error(err.message);

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err.message === "Product not found") {
    res.status(404).json({
      error: {
        code: "PRODUCT_NOT_FOUND",
        message: "Product not found",
      },
    });
    return;
  }

  if (err.message === "One or more products were not found") {
    res.status(404).json({
      error: {
        code: "PRODUCT_NOT_FOUND",
        message: "One or more products were not found",
      },
    });
    return;
  }

  if (err.message === "Insufficient inventory") {
    res.status(409).json({
      error: {
        code: "INSUFFICIENT_INVENTORY",
        message: "Not enough stock available for this order",
      },
    });
    return;
  }

  if (err.message === "Order not found") {
    res.status(404).json({
      error: {
        code: "ORDER_NOT_FOUND",
        message: "Order not found",
      },
    });
    return;
  }

  if (
    err.message === "Only pending orders can be cancelled" ||
    err.message === "Order cannot be cancelled"
  ) {
    res.status(409).json({
      error: {
        code: "ORDER_CANNOT_BE_CANCELLED",
        message: "This order cannot be cancelled in its current state",
      },
    });
    return;
  }

  if (err.message === "Unable to release reserved inventory") {
    res.status(409).json({
      error: {
        code: "INVENTORY_RELEASE_FAILED",
        message: "Unable to release reserved inventory",
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};
