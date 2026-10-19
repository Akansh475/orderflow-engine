import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  err,
  _req,
  res,
  _next,
) => {
  console.error(err.message);

  if (err.message === "Product not found") {
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
