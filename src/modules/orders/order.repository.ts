
import { Prisma, type OrderStatus } from "@prisma/client";
import prisma from "../../config/database.js";
import type { OrderQueryParams } from "./order.validation.js";

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

async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isWriteConflict =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";

      if (!isWriteConflict || attempt === maxAttempts) {
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 25 * attempt),
      );
    }
  }

  throw new Error("Transaction retry limit exceeded");
}

export const orderRepository = {
  findPaginated(params: OrderQueryParams) {
    const where: Prisma.OrderWhereInput = {};
    if (params.status) {
      where.status = params.status;
    }
    if (params.customerId) {
      where.customerId = params.customerId;
    }

    const skip = (params.page - 1) * params.limit;
    const take = params.limit;
    const orderBy = { [params.sortBy]: params.order };

    return prisma.order.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        items: true,
      },
    });
  },

  count(filter: { status?: OrderStatus | undefined; customerId?: string | undefined } = {}) {
    const where: Prisma.OrderWhereInput = {};
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.customerId) {
      where.customerId = filter.customerId;
    }

    return prisma.order.count({ where });
  },

  async findPaginatedWithCount(params: OrderQueryParams) {
    const where: Prisma.OrderWhereInput = {};
    if (params.status) {
      where.status = params.status;
    }
    if (params.customerId) {
      where.customerId = params.customerId;
    }

    const skip = (params.page - 1) * params.limit;
    const take = params.limit;
    const orderBy = { [params.sortBy]: params.order };

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          items: true,
        },
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, total };
  },

  findProductsByIds(productIds: string[]) {
    return prisma.product.findMany({
      where: { id: { in: productIds } },
    });
  },
  findLowStockInventory(threshold: number) {
  return prisma.inventory.findMany({
    where: {
      available: { lte: threshold },
    },
    include: {
      product: true,
    },
    orderBy: {
      available: "asc",
    },
  });
},
async restockInventory(productId: string, quantity: number) {
  return prisma.inventory.upsert({
    where: { productId },
    update: {
      available: { increment: quantity },
    },
    create: {
      productId,
      available: quantity,
      reserved: 0,
    },
  });
},
  findStuckPaymentOrders(cutoff: Date) {
  return prisma.order.findMany({
    where: {
      status: "PAYMENT_PROCESSING",
      updatedAt: { lt: cutoff },
    },
    include: {
      items: true,
      payments: true,
    },
  });
},
async recordPaymentRecovery(
  orderId: string,
  note: string,
) {
  return prisma.orderStatusHistory.create({
    data: {
      orderId,
      status: "PAYMENT_PROCESSING",
      note,
    },
  });
},
 getPaymentById(paymentId: string) {
  return prisma.payment.findUnique({
    where: { id: paymentId },
  });
},
getPaymentsByOrderId(orderId: string) {
  return prisma.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
},
  findById(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        statusHistory: {
          orderBy: { createdAt: "asc" },
        },
      },
    });
  },

  async create(data: CreateOrderData) {
    try {
     return await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
        if (data.idempotencyKey) {
          const existingOrder = await tx.order.findUnique({
            where: { idempotencyKey: data.idempotencyKey },
            include: { items: true },
          });

          if (existingOrder) return existingOrder;
        }

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
            statusHistory: {
              create: {
                status: "PENDING",
                note: "Order created",
              },
            },
          },
          include: {
            items: true,
            statusHistory: {
              orderBy: { createdAt: "asc" },
            },
          },
        });
      }),
    );
    } catch (error) {
      if (
        data.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existingOrder = await prisma.order.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { items: true },
        });

        if (existingOrder) return existingOrder;
      }

      throw error;
    }
  },
  async createPaymentRecord(orderId: string, amount: number) {
  return prisma.payment.create({
    data: {
      orderId,
      amount,
      status: "PENDING",
      message: "Payment attempt created",
    },
  });
},
async updatePaymentRecord(
  paymentId: string,
  result: {
    success: boolean;
    transactionId: string | null;
    message: string;
  },
) {
  return prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: result.success ? "SUCCEEDED" : "FAILED",
      transactionId: result.transactionId,
      message: result.message,
    },
  });
},

  async startPayment(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "PENDING",
        },
        data: {
          status: "PAYMENT_PROCESSING",
        },
      });

      if (updated.count !== 1) {
        const order = await tx.order.findUnique({
          where: { id: orderId },
        });

        if (!order) throw new Error("Order not found");

        throw new Error("Order is not eligible for payment");
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: "PAYMENT_PROCESSING",
          note: "Payment processing started",
        },
      });

      return tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
    });
  },

  
async finalizePayment(
  orderId: string,
  paymentSucceeded: boolean,
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new Error("Order not found");
    }

    if (order.status !== "PAYMENT_PROCESSING") {
      throw new Error(
        "Order is not eligible for payment finalization",
      );
    }

    const nextStatus = paymentSucceeded ? "CONFIRMED" : "FAILED";

    const updated = await tx.order.updateMany({
      where: {
        id: orderId,
        status: "PAYMENT_PROCESSING",
      },
      data: {
        status: nextStatus,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        "Order is not eligible for payment finalization",
      );
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        status: nextStatus,
        note: paymentSucceeded
          ? "Payment successful"
          : "Payment failed",
      },
    });

    if (!paymentSucceeded) {
      for (const item of order.items) {
        const result = await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            reserved: { gte: item.quantity },
          },
          data: {
            reserved: { decrement: item.quantity },
            available: { increment: item.quantity },
          },
        });

        if (result.count !== 1) {
          throw new Error("Unable to release reserved inventory");
        }
      }
    } else {
      await tx.outboxEvent.create({
        data: {
          eventType: "ORDER_CONFIRMED",
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            customerId: order.customerId,
          },
        },
      });
    }

    return tx.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        statusHistory: {
          orderBy: { createdAt: "asc" },
        },
      },
    });
  });
},


  async fulfillOrder(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) throw new Error("Order not found");

      if (order.status !== "CONFIRMED") {
        throw new Error("Only confirmed orders can be fulfilled");
      }

      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "CONFIRMED",
        },
        data: {
          status: "FULFILLED",
        },
      });

      if (updated.count !== 1) {
        throw new Error("Order cannot be fulfilled");
      }

      for (const item of order.items) {
        const result = await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            reserved: { gte: item.quantity },
          },
          data: {
            reserved: { decrement: item.quantity },
          },
        });

        if (result.count !== 1) {
          throw new Error("Unable to finalize reserved inventory");
        }
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: "FULFILLED",
          note: "Order fulfilled",
        },
      });

      return tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          statusHistory: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
    });
  },

  async cancel(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) throw new Error("Order not found");

      if (order.status !== "PENDING") {
        throw new Error("Only pending orders can be cancelled");
      }

      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "PENDING",
        },
        data: {
          status: "CANCELLED",
        },
      });

      if (updated.count !== 1) {
        throw new Error("Order cannot be cancelled");
      }

      for (const item of order.items) {
        const result = await tx.inventory.updateMany({
          where: {
            productId: item.productId,
            reserved: { gte: item.quantity },
          },
          data: {
            reserved: { decrement: item.quantity },
            available: { increment: item.quantity },
          },
        });

        if (result.count !== 1) {
          throw new Error("Unable to release reserved inventory");
        }
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: "CANCELLED",
          note: "Order cancelled",
        },
      });

      return tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: true,
          statusHistory: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
    });
  },
};
