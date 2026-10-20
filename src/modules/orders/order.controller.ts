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
  async getHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = req.params.id;

    if (typeof id !== "string") {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const history = await orderService.getOrderHistory(id);

    return res.status(200).json({ history });
  } catch (error) {
    next(error);
  }
},
async getPayments(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = req.params.id;

    if (typeof id !== "string") {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const payments = await orderService.getOrderPayments(id);

    return res.status(200).json({ payments });
  } catch (error) {
    next(error);
  }
},
async recoverStuckPayments(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await orderService.recoverStuckPayments();

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
},
  async fulfill(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id;

    if (typeof id !== "string") {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const order = await orderService.fulfillOrder(id);

    return res.status(200).json({
      message: "Order fulfilled successfully",
      order,
    });
  } catch (error) {
    next(error);
  }
},
  async pay(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id;

    if (typeof id !== "string") {
      return res.status(400).json({ message: "Invalid order ID" });
    }

    const order = await orderService.payOrder(id);

    return res.status(200).json({
      message: "Payment processed",
      order,
    });
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
async getById(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id;

    if (typeof orderId !== "string") {
      throw new Error("Invalid order ID");
    }

    const order = await orderService.getOrderById(orderId);

    res.status(200).json({ data: order });
  } catch (error) {
    next(error);
  }
},
};