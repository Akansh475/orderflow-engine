export const DEFAULT_ORDER_EXPIRATION_SECONDS = 900; // 15 minutes
export const DEFAULT_ORDER_SWEEPER_INTERVAL_MS = 30000; // 30 seconds
export const DEFAULT_ORDER_SWEEPER_BATCH_SIZE = 50;

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
