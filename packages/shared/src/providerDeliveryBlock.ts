/** the web matches on this exact text to offer recovery — server and client must never drift */
export const PROVIDER_DELIVERY_BLOCK_SUMMARY = "Thread is blocked by an earlier provider failure";
const PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX = `${PROVIDER_DELIVERY_BLOCK_SUMMARY}:`;

export function formatProviderDeliveryBlockDetail(blockerDetail: string): string {
  return `${PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX} ${blockerDetail}`;
}

/** produced by the delivery quarantine — the thread can be recovered by reconciling its blocking deliveries */
export function isProviderDeliveryBlockDetail(detail: string | null | undefined): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.trimStart();
  return (
    normalized === PROVIDER_DELIVERY_BLOCK_SUMMARY ||
    normalized.startsWith(PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX)
  );
}
