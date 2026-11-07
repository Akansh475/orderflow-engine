import { z } from "zod";

export const createWebhookSubscriptionSchema = z.object({
  url: z.string().trim().url("Must be a valid URL"),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional().default(true),
  eventTypes: z
    .array(z.string().trim().min(1))
    .min(1, "At least one event type must be specified")
    .optional()
    .default(["OUTBOX_DEAD_LETTER"]),
  secret: z.string().trim().min(16, "Secret must be at least 16 characters").optional(),
});

export const updateWebhookSubscriptionSchema = z.object({
  url: z.string().trim().url("Must be a valid URL").optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  eventTypes: z
    .array(z.string().trim().min(1))
    .min(1, "At least one event type must be specified")
    .optional(),
  secret: z.string().trim().min(16, "Secret must be at least 16 characters").optional(),
});

export const webhookListQuerySchema = z.object({
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
    .default(20),
  isActive: z
    .enum(["true", "false"])
    .transform((val) => val === "true")
    .optional(),
});

export const deliveryListQuerySchema = z.object({
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
    .default(20),
  status: z.enum(["PENDING", "SUCCESS", "FAILED"]).optional(),
  webhookId: z.string().trim().min(1).optional(),
  outboxEventId: z.string().trim().min(1).optional(),
});

export type CreateWebhookSubscriptionInput = z.infer<typeof createWebhookSubscriptionSchema>;
export type UpdateWebhookSubscriptionInput = z.infer<typeof updateWebhookSubscriptionSchema>;
export type WebhookListQueryParams = z.infer<typeof webhookListQuerySchema>;
export type DeliveryListQueryParams = z.infer<typeof deliveryListQuerySchema>;
