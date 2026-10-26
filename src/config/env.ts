export const DEFAULT_ORDER_EXPIRATION_SECONDS = 900; // 15 minutes

export function getOrderExpirationSeconds(): number {
  const envVal = process.env.ORDER_EXPIRATION_SECONDS;
  if (!envVal) return DEFAULT_ORDER_EXPIRATION_SECONDS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ORDER_EXPIRATION_SECONDS;
}
