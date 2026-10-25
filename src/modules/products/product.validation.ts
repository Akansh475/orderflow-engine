import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  description: z.string().optional(),
  price: z.coerce.number().positive("Price must be greater than zero"),
});

export const productQuerySchema = z.object({
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
  sortBy: z.enum(["createdAt", "name", "price"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().trim().optional(),
});

export type ProductQueryParams = z.output<typeof productQuerySchema>;
