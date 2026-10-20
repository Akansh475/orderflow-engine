
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("GET /health", () => {
  it("should return the service health status", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "orderflow-engine",
    });
  });
});

describe("GET /health/db", () => {
  it("should confirm the database is connected", async () => {
    const response = await request(app).get("/health/db");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      database: "connected",
    });
  });
});
