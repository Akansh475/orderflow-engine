import type { Request, Response, NextFunction } from "express";
import { outboxService } from "./outbox.service.js";

export const outboxController = {
  /**
   * GET /admin/outbox/dead-letter
   * Lists dead-lettered events with pagination and optional eventType filter.
   */
  async listDeadLetter(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page !== undefined ? Number(req.query.page) : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const eventType =
        typeof req.query.eventType === "string" ? req.query.eventType.trim() : undefined;

      if (page !== undefined && (!Number.isFinite(page) || page < 1)) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "page must be a positive integer",
          },
        });
        return;
      }

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "limit must be a positive integer",
          },
        });
        return;
      }

      const result = await outboxService.getDeadLetterEvents({
        page,
        limit,
        eventType,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * GET /admin/outbox/dead-letter/:id
   * Retrieves full details of a specific dead-letter event.
   */
  async getDeadLetterById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const event = await outboxService.getDeadLetterById(id);
      res.status(200).json({ data: event });
    } catch (error) {
      next(error);
    }
  },

  /**
   * POST /admin/outbox/dead-letter/:id/replay
   * Explicitly queues a dead-letter event for retry.
   */
  async replay(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const replayed = await outboxService.replayDeadLetterEvent(id);
      res.status(200).json({
        message: "Dead-letter outbox event queued for replay",
        data: replayed,
      });
    } catch (error) {
      next(error);
    }
  },
};
