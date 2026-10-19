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

  create(data: {
  name: string;
  description?: string | undefined;
  price: number;
}) {
  return prisma.product.create({
    data: {
      name: data.name,
      ...(data.description !== undefined && {
        description: data.description,
      }),
      price: data.price,
    },
  });
},
};