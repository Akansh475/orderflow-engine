import { Prisma } from "@prisma/client";
import prisma from "../../config/database.js";
import type { ProductQueryParams } from "./product.validation.js";

export const productRepository = {
  findAll(params?: ProductQueryParams) {
    if (!params) {
      return prisma.product.findMany({
        orderBy: { createdAt: "desc" },
      });
    }

    const where: Prisma.ProductWhereInput = {};
    if (params.search && params.search.length > 0) {
      where.name = {
        contains: params.search,
        mode: "insensitive",
      };
    }

    return prisma.product.findMany({
      where,
      orderBy: { [params.sortBy]: params.order },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
  },

  findPaginated(params: ProductQueryParams) {
    const where: Prisma.ProductWhereInput = {};
    if (params.search && params.search.length > 0) {
      where.name = {
        contains: params.search,
        mode: "insensitive",
      };
    }

    return prisma.product.findMany({
      where,
      orderBy: { [params.sortBy]: params.order },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });
  },

  count(filter: { search?: string | undefined } = {}) {
    const where: Prisma.ProductWhereInput = {};
    if (filter.search && filter.search.length > 0) {
      where.name = {
        contains: filter.search,
        mode: "insensitive",
      };
    }

    return prisma.product.count({ where });
  },

  async findPaginatedWithCount(params: ProductQueryParams) {
    const where: Prisma.ProductWhereInput = {};
    if (params.search && params.search.length > 0) {
      where.name = {
        contains: params.search,
        mode: "insensitive",
      };
    }

    const [products, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        orderBy: { [params.sortBy]: params.order },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prisma.product.count({ where }),
    ]);

    return { products, total };
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

  async update(
    id: string,
    data: {
      name?: string | undefined;
      description?: string | null | undefined;
      price?: number | undefined;
    },
  ) {
    try {
      return await prisma.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.price !== undefined && { price: data.price }),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        return null;
      }
      throw error;
    }
  },

  async delete(id: string) {
    try {
      return await prisma.product.delete({
        where: { id },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") {
          return null;
        }
        if (error.code === "P2003") {
          throw new Error(
            "Product cannot be deleted because it is referenced by existing records",
          );
        }
      }
      throw error;
    }
  },
};
