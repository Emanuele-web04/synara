// Only successful transport negotiation may establish the journal namespace.
let verifiedServerInstanceId: string | null = null;
const listeners = new Set<(identity: string, previous: string | null) => void>();
export function getVerifiedThreadCacheIdentity(): string | null {
  return verifiedServerInstanceId;
}
export function adoptVerifiedThreadCacheIdentity(identity: string): void {
  if (identity === verifiedServerInstanceId) return;
  const previous = verifiedServerInstanceId;
  verifiedServerInstanceId = identity;
  for (const listener of listeners) listener(identity, previous);
}
export function subscribeThreadCacheIdentity(
  listener: (identity: string, previous: string | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
