import { createOrderSchema } from "./order.validation.js";
import { orderRepository } from "./order.repository.js";
import { paymentService } from "../payments/payment.service.js";

export const orderService = {
  async validateAndCalculateOrder(input: unknown) {
    const data = createOrderSchema.parse(input);

    const productIds = [...new Set(data.items.map((item) => item.productId))];

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

    return orderRepository.create({
      customerId: data.customerId,
      idempotencyKey: data.idempotencyKey,
      items,
      total: Number(total.toFixed(2)),
    });
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

return {
  order: updatedOrder,
  payment: await orderRepository.getPaymentById(paymentRecord.id),
};
},
  async cancelOrder(orderId: string) {
  return orderRepository.cancel(orderId);
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
