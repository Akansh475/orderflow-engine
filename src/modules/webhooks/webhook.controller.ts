import type { Request, Response, NextFunction } from "express";
import { webhookService } from "./webhook.service.js";
import {
  createWebhookSubscriptionSchema,
  updateWebhookSubscriptionSchema,
  webhookListQuerySchema,
} from "./webhook.validation.js";

export const webhookController = {
  /**
   * POST /admin/webhooks
   * Registers a new webhook subscription.
   */
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedBody = createWebhookSubscriptionSchema.parse(req.body);
      const subscription = await webhookService.createSubscription(parsedBody);
      res.status(201).json({
        data: subscription,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /admin/webhooks
   * Lists registered webhook destinations with pagination and optional filter.
   */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = webhookListQuerySchema.parse(req.query);
      const result = await webhookService.listSubscriptions(query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /admin/webhooks/:id
   * Retrieves a specific webhook subscription by ID.
   */
  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const subscription = await webhookService.getSubscriptionById(id);
      res.status(200).json({ data: subscription });
    } catch (error) {
      next(error);
    }
  },

  /**
   * PATCH /admin/webhooks/:id
   * Updates an existing webhook subscription (e.g. activate/deactivate, change URL, event types).
   */
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const parsedBody = updateWebhookSubscriptionSchema.parse(req.body);
      const subscription = await webhookService.updateSubscription(id, parsedBody);
      res.status(200).json({ data: subscription });
    } catch (error) {
      next(error);
    }
  },

  /**
   * DELETE /admin/webhooks/:id
   * Deletes a registered webhook destination.
   */
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await webhookService.deleteSubscription(id);
      res.status(200).json({
        message: "Webhook subscription deleted successfully",
        id: result.id,
      });
    } catch (error) {
      next(error);
    }
  },
};
