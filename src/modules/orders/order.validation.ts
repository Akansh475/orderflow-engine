import { z } from "zod";
import { OrderStatus } from "@prisma/client";

export const createOrderSchema = z.object({
  customerId: z.string().trim().min(1, "Customer ID is required"),
  idempotencyKey: z.string().trim().min(1).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, "Product ID is required"),
        quantity: z.number().int().positive("Quantity must be positive"),
      }),
    )
    .min(1, "An order must contain at least one item"),
});

export const orderQuerySchema = z.object({
  page: z.coerce
    .number()
    .int("Page must be an integer")
    .positive("Page must be a positive integer")
    .default(1),
  limit: z.coerce
    .number()
    .int("Limit must be an integer")
    .positive("Limit must be a positive integer")
    .max(100, "Limit cannot exceed 100")
    .default(10),
  status: z.nativeEnum(OrderStatus).optional(),
  customerId: z
    .string()
    .trim()
    .min(1, "Customer ID must not be empty")
    .optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "total"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type OrderQueryParams = z.output<typeof orderQuerySchema>;
