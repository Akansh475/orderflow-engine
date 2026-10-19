
import prisma from "../../config/database.js";

type CreateOrderData = {
  customerId: string;
  items: {
    productId: string;
    quantity: number;
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
      return tx.order.create({
        data: {
          customerId: data.customerId,
          total: data.total,
          items: {
            create: data.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: 0,
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
