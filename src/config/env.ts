export const DEFAULT_ORDER_EXPIRATION_SECONDS = 900; // 15 minutes
export const DEFAULT_ORDER_SWEEPER_INTERVAL_MS = 30000; // 30 seconds
export const DEFAULT_ORDER_SWEEPER_BATCH_SIZE = 50;

export const DEFAULT_OUTBOX_RETRY_BASE_DELAY_MS = 5000; // 5 seconds
export const DEFAULT_OUTBOX_RETRY_MAX_DELAY_MS = 900000; // 15 minutes
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const DEFAULT_OUTBOX_RETRY_JITTER_ENABLED = false;
export const DEFAULT_OUTBOX_RETRY_JITTER_FACTOR = 0.2; // up to 20% jitter

export function getOrderExpirationSeconds(): number {
  const envVal = process.env.ORDER_EXPIRATION_SECONDS;
  if (!envVal) return DEFAULT_ORDER_EXPIRATION_SECONDS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ORDER_EXPIRATION_SECONDS;
}

export function getOrderSweeperIntervalMs(): number {
  const envVal = process.env.ORDER_SWEEPER_INTERVAL_MS;
  if (!envVal) return DEFAULT_ORDER_SWEEPER_INTERVAL_MS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ORDER_SWEEPER_INTERVAL_MS;
}

export function getOrderSweeperBatchSize(): number {
  const envVal = process.env.ORDER_SWEEPER_BATCH_SIZE;
  if (!envVal) return DEFAULT_ORDER_SWEEPER_BATCH_SIZE;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ORDER_SWEEPER_BATCH_SIZE;
}

export function getOutboxRetryBaseDelayMs(): number {
  const envVal = process.env.OUTBOX_RETRY_BASE_DELAY_MS;
  if (!envVal) return DEFAULT_OUTBOX_RETRY_BASE_DELAY_MS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OUTBOX_RETRY_BASE_DELAY_MS;
}

export function getOutboxRetryMaxDelayMs(): number {
  const envVal = process.env.OUTBOX_RETRY_MAX_DELAY_MS;
  if (!envVal) return DEFAULT_OUTBOX_RETRY_MAX_DELAY_MS;
  const parsed = Number(envVal);
  const baseDelay = getOutboxRetryBaseDelayMs();
  return Number.isFinite(parsed) && parsed >= baseDelay
    ? parsed
    : DEFAULT_OUTBOX_RETRY_MAX_DELAY_MS;
}

export function getOutboxMaxAttempts(): number {
  const envVal = process.env.OUTBOX_MAX_ATTEMPTS;
  if (!envVal) return DEFAULT_OUTBOX_MAX_ATTEMPTS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_OUTBOX_MAX_ATTEMPTS;
}

export function getOutboxRetryJitterEnabled(): boolean {
  const envVal = process.env.OUTBOX_RETRY_JITTER_ENABLED;
  if (!envVal) return DEFAULT_OUTBOX_RETRY_JITTER_ENABLED;
  return envVal.toLowerCase() === "true" || envVal === "1";
}

export function getOutboxRetryJitterFactor(): number {
  const envVal = process.env.OUTBOX_RETRY_JITTER_FACTOR;
  if (!envVal) return DEFAULT_OUTBOX_RETRY_JITTER_FACTOR;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_OUTBOX_RETRY_JITTER_FACTOR;
}

export function getAdminApiKey(): string | undefined {
  return process.env.ADMIN_API_KEY ? process.env.ADMIN_API_KEY.trim() : undefined;
}
