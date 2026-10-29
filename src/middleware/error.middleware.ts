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
    err instanceof ZodError ||
    err.message === "Cannot order archived products"
      ? 400
      : err.message === "Product not found" ||
          err.message === "One or more products were not found" ||
          err.message === "Order not found" ||
          (err as { code?: string }).code === "P2025"
        ? 404
        : err.message === "Insufficient inventory" ||
            err.message === "Order is not eligible for payment" ||
            err.message === "Order is not eligible for payment finalization" ||
            err.message === "Order is not eligible for expiration" ||
            err.message === "Only pending orders can be cancelled" ||
            err.message === "Order cannot be cancelled" ||
            err.message === "Unable to release reserved inventory" ||
            err.message === "Product cannot be deleted because it is referenced by existing records" ||
            (err as { code?: string }).code === "P2003"
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
    "Order is not eligible for expiration": {
      code: "ORDER_NOT_ELIGIBLE_FOR_EXPIRATION",
      message: "This order cannot be expired in its current state",
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
    "Product cannot be deleted because it is referenced by existing records": {
      code: "PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION",
      message:
        "Product cannot be deleted because it is referenced by existing orders or inventory",
    },
    "Cannot order archived products": {
      code: "PRODUCT_ARCHIVED",
      message: "Cannot create order with archived products",
    },
  };

  const knownError = knownErrors[err.message];

  if (knownError) {
    res.status(status).json({ error: knownError });
    return;
  }

  if ((err as { code?: string }).code === "P2003") {
    res.status(409).json({
      error: {
        code: "PRODUCT_REFERENTIAL_INTEGRITY_VIOLATION",
        message:
          "Product cannot be deleted because it is referenced by existing orders or inventory",
      },
    });
    return;
  }

  if ((err as { code?: string }).code === "P2025") {
    res.status(404).json({
      error: {
        code: "PRODUCT_NOT_FOUND",
        message: "Product not found",
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