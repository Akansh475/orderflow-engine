import type { Request, Response, NextFunction } from "express";
import { orderService } from "./order.service.js";

export const orderController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const order = await orderService.validateAndCalculateOrder(req.body);

      res.status(201).json({ data: order });
    } catch (error) {
      next(error);
    }
  },
  async cancel(req: Request, res: Response, next: NextFunction) {
  try {
   const orderId = req.params.id;

if (typeof orderId !== "string") {
  throw new Error("Invalid order ID");
}

const order = await orderService.cancelOrder(orderId);

    res.status(200).json({ data: order });
  } catch (error) {
    next(error);
  }
},
};