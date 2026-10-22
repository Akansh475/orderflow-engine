import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger.js";

export const errorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next,
) => {
  const status =
    err instanceof ZodError
      ? 400
      : err.message === "Product not found" ||
          err.message === "One or more products were not found" ||
          err.message === "Order not found"
        ? 404
        : err.message === "Insufficient inventory" ||
            err.message === "Order is not eligible for payment" ||
            err.message === "Order is not eligible for payment finalization" ||
            err.message === "Only pending orders can be cancelled" ||
            err.message === "Order cannot be cancelled" ||
            err.message === "Unable to release reserved inventory"
          ? 409
          : 500;

  logger[status >= 500 ? "error" : "warn"](
    {
      err,
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: status,
    },
    "Request failed",
  );

  if (res.headersSent) {
    _next(err);
    return;
  }

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

  const knownErrors: Record<string, { code: string; message: string }> = {
    "Product not found": {
      code: "PRODUCT_NOT_FOUND",
      message: "Product not found",
    },
    "One or more products were not found": {
      code: "PRODUCT_NOT_FOUND",
      message: "One or more products were not found",
    },
    "Insufficient inventory": {
      code: "INSUFFICIENT_INVENTORY",
      message: "Not enough stock available for this order",
    },
    "Order not found": {
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
    },
    "Order is not eligible for payment": {
      code: "ORDER_NOT_ELIGIBLE_FOR_PAYMENT",
      message: err.message,
    },
    "Order is not eligible for payment finalization": {
      code: "ORDER_NOT_ELIGIBLE_FOR_PAYMENT",
      message: err.message,
    },
    "Only pending orders can be cancelled": {
      code: "ORDER_CANNOT_BE_CANCELLED",
      message: "This order cannot be cancelled in its current state",
    },
    "Order cannot be cancelled": {
      code: "ORDER_CANNOT_BE_CANCELLED",
      message: "This order cannot be cancelled in its current state",
    },
    "Unable to release reserved inventory": {
      code: "INVENTORY_RELEASE_FAILED",
      message: "Unable to release reserved inventory",
    },
  };

  const knownError = knownErrors[err.message];

  if (knownError) {
    res.status(status).json({ error: knownError });
    return;
  }

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};