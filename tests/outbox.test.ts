
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import app from "../src/app.js";

const prisma = new PrismaClient();

describe("Transactional Outbox", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should create an outbox event when payment succeeds", async () => {
    const product = await prisma.product.create({
      data: {
        name: `Outbox Test Product ${Date.now()}`,
        price: 100,
        inventory: {
          create: {
            available: 5,
            reserved: 0,
          },
        },
      },
    });

    const orderResponse = await request(app)
      .post("/orders")
      .send({
        customerId: "outbox-test-customer",
        idempotencyKey: `outbox-test-${Date.now()}`,
        items: [{ productId: product.id, quantity: 1 }],
      });

    expect(orderResponse.status).toBe(201);

    const orderId = orderResponse.body.data.id as string;

    const paymentResponse = await request(app).post(`/orders/${orderId}/pay`);

    expect(paymentResponse.status).toBe(200);

    const event = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: orderId,
        eventType: "ORDER_CONFIRMED",
      },
    });

    expect(event).not.toBeNull();
    expect(event?.payload).toMatchObject({
      orderId,
      customerId: "outbox-test-customer",
    });
    expect(event?.processedAt).toBeNull();
  });
});
