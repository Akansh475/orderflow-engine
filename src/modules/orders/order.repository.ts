
import prisma from "../../config/database.js";

type CreateOrderData = {
  customerId: string;
  items: {
    productId: string;
    quantity: number;
    unitPrice: number;
  }[];
  total: number;
};

export const orderRepository = {
  findProductsByIds(productIds: string[]) {
    return prisma.product.findMany({
      where: {
        id: { in: productIds },
      },
    });
  },

  create(data: CreateOrderData) {
    return prisma.$transaction(async (tx) => {
      for (const item of data.items) {
        const result = await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            available: { gte: item.quantity },
          },
          data: {
            available: { decrement: item.quantity },
            reserved: { increment: item.quantity },
          },
        });

        if (result.count !== 1) {
          throw new Error("Insufficient inventory");
        }
      }

      return tx.order.create({
        data: {
          customerId: data.customerId,
          total: data.total,
          items: {
            create: data.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: {
          items: true,
        },
      });
    });
  },
};
