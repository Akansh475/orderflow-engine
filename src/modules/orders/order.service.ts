
import { createOrderSchema } from "./order.validation.js";
import { orderRepository } from "./order.repository.js";

export const orderService = {
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

    return orderRepository.create({
      customerId: data.customerId,
      items,
      total: Number(total.toFixed(2)),
    });
  },
};
