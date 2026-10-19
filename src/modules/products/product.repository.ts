import prisma from "../../config/database.js";

export const productRepository = {
  findAll() {
    return prisma.product.findMany({
      orderBy: { createdAt: "desc" },
    });
  },

  findById(id: string) {
    return prisma.product.findUnique({
      where: { id },
    });
  },
};
