import type { Prisma } from "@prisma/client";
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
};
