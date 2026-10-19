
import { z } from "zod";

export const createOrderSchema = z.object({
  customerId: z.string().trim().min(1, "Customer ID is required"),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, "Product ID is required"),
        quantity: z.number().int().positive("Quantity must be positive"),
      }),
    )
    .min(1, "An order must contain at least one item"),
});
