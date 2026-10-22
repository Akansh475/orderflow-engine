
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { outboxPublisher } from "../src/modules/outbox/outbox.publisher.js";

const prisma = new PrismaClient();

describe("Outbox Publisher", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("should publish a pending order confirmation event", async () => {
    const orderId = `publisher-test-${Date.now()}`;

    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "ORDER_CONFIRMED",
        aggregateId: orderId,
        payload: {
          orderId,
          customerId: "publisher-test-customer",
        },
      },
    });

    const result = await outboxPublisher.publishPendingEvents();

    expect(result.found).toBeGreaterThanOrEqual(1);

    const updatedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });

    expect(updatedEvent?.processedAt).not.toBeNull();
    expect(updatedEvent?.attempts).toBe(1);
    expect(updatedEvent?.lastError).toBeNull();
  });
});
