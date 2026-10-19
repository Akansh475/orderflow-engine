import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  description: z.string().optional(),
  price: z.coerce.number().positive("Price must be greater than zero"),
});