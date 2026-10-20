
import { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";

type CreateOrderData = {
  customerId: string;
  idempotencyKey?: string | undefined;
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

  async create(data: CreateOrderData) {
    try {
      return await prisma.$transaction(async (tx) => {
        // 1. Return the existing order if this key was already used.
        if (data.idempotencyKey) {
          const existingOrder = await tx.order.findUnique({
            where: {
              idempotencyKey: data.idempotencyKey,
            },
            include: {
              items: true,
            },
          });

          if (existingOrder) {
            return existingOrder;
          }
        }

        // 2. Reserve inventory atomically.
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

        // 3. Create the order and its items.
        return tx.order.create({
          data: {
            customerId: data.customerId,
            ...(data.idempotencyKey
              ? { idempotencyKey: data.idempotencyKey }
              : {}),
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
    } catch (error) {
      // A concurrent request may have created the same order first.
      if (
        data.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existingOrder = await prisma.order.findUnique({
          where: {
            idempotencyKey: data.idempotencyKey,
          },
          include: {
            items: true,
          },
        });

        if (existingOrder) {
          return existingOrder;
        }
      }

      throw error;
    }
  },
};
