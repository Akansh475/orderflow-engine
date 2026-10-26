
import { createOrderSchema, orderQuerySchema } from "./order.validation.js";
import { orderRepository } from "./order.repository.js";
import { paymentService } from "../payments/payment.service.js";
import { createPaginationMeta } from "../../shared/types.js";
import { enqueueOrderExpiration } from "../../queues/order.queue.js";
import { getOrderExpirationSeconds } from "../../config/env.js";
import { logger } from "../../config/logger.js";
//import { enqueueOrderConfirmation } from "../../queues/order.queue.js";


export const orderService = {
  async listOrders(query: unknown = {}) {
    const params = orderQuerySchema.parse(query);
    const { orders, total } =
      await orderRepository.findPaginatedWithCount(params);

    return {
      data: orders,
      pagination: createPaginationMeta(params.page, params.limit, total),
    };
  },

  async validateAndCalculateOrder(input: unknown) {
    const data = createOrderSchema.parse(input);

    const productIds = [
      ...new Set(data.items.map((item) => item.productId)),
    ];

    const products = await orderRepository.findProductsByIds(productIds);

    if (products.length !== productIds.length) {
      throw new Error("One or more products were not found");
    }

    const total = data.items.reduce((sum, item) => {
      const product = products.find((p) => p.id === item.productId)!;
      return sum + Number(product.price) * item.quantity;
    }, 0);

    const items = data.items.map((item) => {
      const product = products.find((p) => p.id === item.productId)!;

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: Number(product.price),
      };
    });

    const order = await orderRepository.create({
      customerId: data.customerId,
      idempotencyKey: data.idempotencyKey,
      items,
      total: Number(total.toFixed(2)),
    });

    try {
      const expirationDelayMs = getOrderExpirationSeconds() * 1000;
      await enqueueOrderExpiration(order.id, expirationDelayMs);
    } catch (error) {
      logger.warn(
        { orderId: order.id, err: error },
        "Failed to enqueue order expiration job; sweeper will reconcile",
      );
    }

    return order;
  },

  async payOrder(orderId: string) {
    const order = await orderRepository.startPayment(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    const paymentRecord = await orderRepository.createPaymentRecord(
      order.id,
      Number(order.total),
    );

    let payment;

    try {
      payment = await paymentService.processPayment(
        order.id,
        Number(order.total),
      );
    } catch (error) {
      const failedPayment = {
        success: false,
        transactionId: null,
        message: "Payment provider error",
      };

      await orderRepository.updatePaymentRecord(
        paymentRecord.id,
        failedPayment,
      );

      await orderRepository.finalizePayment(order.id, false);

      throw error;
    }

    await orderRepository.updatePaymentRecord(paymentRecord.id, payment);

    const updatedOrder = await orderRepository.finalizePayment(
  order.id,
  payment.success,
);

if (!updatedOrder) {
  throw new Error("Order not found after payment finalization");
}

// if (payment.success && updatedOrder.status === "CONFIRMED") {
//   await enqueueOrderConfirmation(order.id, order.customerId);
// }

    return {
      order: updatedOrder,
      payment: await orderRepository.getPaymentById(paymentRecord.id),
    };
  },

  async cancelOrder(orderId: string) {
    return orderRepository.cancel(orderId);
  },

  async expireOrder(orderId: string) {
    return orderRepository.expireOrder(orderId);
  },

  async expireStaleOrders(olderThanSeconds?: number, batchLimit = 50) {
    const ttlSeconds =
      olderThanSeconds !== undefined && olderThanSeconds > 0
        ? olderThanSeconds
        : getOrderExpirationSeconds();

    const cutoff = new Date(Date.now() - ttlSeconds * 1000);
    const expiredIds: string[] = [];
    let totalChecked = 0;

    while (true) {
      const staleOrders = await orderRepository.findStalePendingOrders(
        cutoff,
        batchLimit,
      );

      if (staleOrders.length === 0) {
        break;
      }

      totalChecked += staleOrders.length;

      for (const order of staleOrders) {
        try {
          await orderRepository.expireOrder(order.id);
          expiredIds.push(order.id);
        } catch (error) {
          logger.warn(
            { orderId: order.id, err: error },
            "Failed to expire stale order during sweep reconciliation",
          );
        }
      }

      if (staleOrders.length < batchLimit || expiredIds.length >= 500) {
        break;
      }
    }

    return {
      checked: totalChecked,
      expiredCount: expiredIds.length,
      orderIds: expiredIds,
      cutoff: cutoff.toISOString(),
    };
  },

  async fulfillOrder(orderId: string) {
    return orderRepository.fulfillOrder(orderId);
  },

  async getOrderById(orderId: string) {
    const order = await orderRepository.findById(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    return order;
  },

  async getOrderHistory(orderId: string) {
    const order = await orderRepository.findById(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    return order.statusHistory;
  },

  async getOrderPayments(orderId: string) {
    const order = await orderRepository.findById(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    return orderRepository.getPaymentsByOrderId(orderId);
  },

  async getLowStockInventory(threshold = 5) {
    if (!Number.isInteger(threshold) || threshold < 0) {
      throw new Error("Stock threshold must be a non-negative integer");
    }

    return orderRepository.findLowStockInventory(threshold);
  },

  async restockInventory(productId: string, quantity: number) {
    if (!productId.trim()) {
      throw new Error("Product ID is required");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Restock quantity must be a positive integer");
    }

    const products = await orderRepository.findProductsByIds([productId]);

    if (products.length === 0) {
      throw new Error("One or more products were not found");
    }

    return orderRepository.restockInventory(productId, quantity);
  },

  async recoverStuckPayments() {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);

    const orders = await orderRepository.findStuckPaymentOrders(cutoff);

    for (const order of orders) {
      await orderRepository.recordPaymentRecovery(
        order.id,
        "Recovery check performed; payment outcome requires reconciliation",
      );
    }

    return {
      checked: orders.length,
      orderIds: orders.map((order) => order.id),
      message: "Recovery checks recorded; no payment states were changed",
    };
  },
};
