
import prisma from "../../config/database.js";

export const inventoryRepository = {
  async reserveStock(
    productId: string,
    quantity: number,
  ) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.inventory.updateMany({
        where: {
          productId,
          available: { gte: quantity },
        },
        data: {
          available: { decrement: quantity },
          reserved: { increment: quantity },
        },
      });

      if (result.count === 0) {
        throw new Error("Insufficient inventory");
      }

      return result;
    });
  },
};
