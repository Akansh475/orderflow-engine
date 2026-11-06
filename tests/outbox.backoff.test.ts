import { describe, expect, it } from "vitest";
import {
  calculateRetryDelayMs,
  calculateNextAttemptAt,
  isMaxAttemptsReached,
} from "../src/modules/outbox/outbox.backoff.js";

describe("Outbox Exponential Backoff Calculation", () => {
  const baseDelayMs = 5000;
  const maxDelayMs = 900000; // 15 minutes

  describe("1. First Retry Delay", () => {
    it("should calculate exact base delay for the first failed attempt", () => {
      const delay = calculateRetryDelayMs(1, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });

      expect(delay).toBe(5000);
    });
  });

  describe("2. Increasing Exponential Retry Delays", () => {
    it("should double the delay exponentially for subsequent attempts", () => {
      const delay1 = calculateRetryDelayMs(1, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });
      const delay2 = calculateRetryDelayMs(2, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });
      const delay3 = calculateRetryDelayMs(3, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });
      const delay4 = calculateRetryDelayMs(4, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });

      expect(delay1).toBe(5000);
      expect(delay2).toBe(10000); // 5000 * 2^1
      expect(delay3).toBe(20000); // 5000 * 2^2
      expect(delay4).toBe(40000); // 5000 * 2^3
    });
  });

  describe("3. Maximum Delay Cap", () => {
    it("should cap the delay at maxDelayMs regardless of high attempt counts", () => {
      const delayAttempt10 = calculateRetryDelayMs(10, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });
      const delayAttempt20 = calculateRetryDelayMs(20, {
        baseDelayMs,
        maxDelayMs,
        enableJitter: false,
      });

      expect(delayAttempt10).toBe(maxDelayMs);
      expect(delayAttempt20).toBe(maxDelayMs);
    });
  });

  describe("4. Jitter Behavior", () => {
    it("should apply bounded additive jitter when jitter is enabled", () => {
      const jitterFactor = 0.2;
      const rawDelay = 5000;

      for (let i = 0; i < 50; i++) {
        const jittered = calculateRetryDelayMs(1, {
          baseDelayMs,
          maxDelayMs,
          enableJitter: true,
          jitterFactor,
        });

        expect(jittered).toBeGreaterThanOrEqual(rawDelay);
        expect(jittered).toBeLessThanOrEqual(rawDelay * (1 + jitterFactor) + 1);
      }
    });
  });

  describe("5. Next Attempt Date and Max Attempts Threshold", () => {
    it("should correctly compute nextAttemptAt timestamp relative to given time", () => {
      const fixedNow = new Date("2026-11-06T12:00:00.000Z");
      const nextAttempt = calculateNextAttemptAt(
        1,
        { baseDelayMs: 5000, enableJitter: false },
        fixedNow,
      );

      expect(nextAttempt.getTime()).toBe(fixedNow.getTime() + 5000);
    });

    it("should identify when max attempts threshold is reached", () => {
      const maxAttempts = 5;
      expect(isMaxAttemptsReached(1, maxAttempts)).toBe(false);
      expect(isMaxAttemptsReached(4, maxAttempts)).toBe(false);
      expect(isMaxAttemptsReached(5, maxAttempts)).toBe(true);
      expect(isMaxAttemptsReached(6, maxAttempts)).toBe(true);
    });
  });
});
