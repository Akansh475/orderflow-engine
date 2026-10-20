
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("POST /products", () => {
  it("should reject a product with an invalid price", async () => {
    const response = await request(app)
      .post("/products")
      .send({
        name: "Test Product",
        price: -10,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
