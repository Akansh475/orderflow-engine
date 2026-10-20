
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";

const prisma = new PrismaClient();

describe("Orders API", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should create an order and calculate its total from product prices", async () => {
    const product = await prisma.product.create({
      data: {
        name: "Test Mouse",
        price: 799,
        inventory: {
          create: {
            available: 10,
            reserved: 0,
          },
        },
      },
    });

    const response = await request(app)
      .post("/orders")
      .send({
        customerId: "customer-test-001",
        idempotencyKey: `test-order-${Date.now()}`,
        items: [
          {
            productId: product.id,
            quantity: 2,
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.customerId).toBe("customer-test-001");
    expect(response.body.data.total).toBe("1598");
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].quantity).toBe(2);

    const inventory = await prisma.inventory.findUnique({
      where: { productId: product.id },
    });

    expect(inventory?.available).toBe(8);
    expect(inventory?.reserved).toBe(2);
  });
});
