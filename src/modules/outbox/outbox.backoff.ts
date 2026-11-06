import {
  getOutboxRetryBaseDelayMs,
  getOutboxRetryMaxDelayMs,
  getOutboxMaxAttempts,
  getOutboxRetryJitterEnabled,
  getOutboxRetryJitterFactor,
} from "../../config/env.js";

export interface BackoffOptions {
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  enableJitter?: boolean | undefined;
  jitterFactor?: number | undefined;
}

/**
 * Calculates the exponential retry delay for a given attempt number.
 *
 * Formula:
 *   delay = min(baseDelay * 2^(attempts - 1), maxDelay) + jitter
 *
 * Defaults:
 *   baseDelay: 5,000 ms (5s)
 *   maxDelay: 900,000 ms (15m)
 *   jitter: optional additive noise (up to jitterFactor * rawDelay)
 */
export function calculateRetryDelayMs(
  attempts: number,
  options?: BackoffOptions,
): number {
  const baseDelay = options?.baseDelayMs ?? getOutboxRetryBaseDelayMs();
  const maxDelay = options?.maxDelayMs ?? getOutboxRetryMaxDelayMs();
  const enableJitter = options?.enableJitter ?? getOutboxRetryJitterEnabled();
  const jitterFactor = options?.jitterFactor ?? getOutboxRetryJitterFactor();

  const safeAttempts = Math.max(1, attempts);
  const exponent = Math.min(safeAttempts - 1, 30);
  const rawDelay = Math.min(baseDelay * Math.pow(2, exponent), maxDelay);

  if (!enableJitter || jitterFactor <= 0) {
    return Math.round(rawDelay);
  }

  // Additive jitter: [0, jitterFactor * rawDelay]
  const jitter = Math.random() * (rawDelay * jitterFactor);
  return Math.round(rawDelay + jitter);
}

/**
 * Computes the Date when the event is next eligible for retry.
 */
export function calculateNextAttemptAt(
  attempts: number,
  options?: BackoffOptions,
  now = new Date(),
): Date {
  const delayMs = calculateRetryDelayMs(attempts, options);
  return new Date(now.getTime() + delayMs);
}

/**
 * Determines whether the event has reached or exceeded the maximum retry limit.
 */
export function isMaxAttemptsReached(
  attempts: number,
  maxAttempts?: number | undefined,
): boolean {
  const limit = maxAttempts ?? getOutboxMaxAttempts();
  return attempts >= limit;
}
