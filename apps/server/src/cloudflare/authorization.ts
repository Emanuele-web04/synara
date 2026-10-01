import { setTimeout as delay } from "node:timers/promises";
import { AccountApiError } from "@synara/shared/account";
import type { HostAuthorizationSnapshot } from "@synara/contracts";

export const REMOTE_AUTHORIZATION_LEASE_MS = 60_000;
export const REMOTE_REVOCATION_POLL_MS = 10_000;

/** A fresh lease gates all admission and closes existing streams during an API outage. */
export function startRemoteAuthorization(options: {
  refresh: () => Promise<HostAuthorizationSnapshot>;
  apply: (snapshot: HostAuthorizationSnapshot) => Promise<void>;
  unavailable: (permanent: boolean) => Promise<void>;
  signal: AbortSignal;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let validUntil = 0;
  let permanentlyDenied = false;
  let expired = true;
  const available = () => !options.signal.aborted && !permanentlyDenied && now() < validUntil;
  const expiry = setInterval(() => {
    if (!expired && !available()) {
      expired = true;
      void options.unavailable(false).catch(() => {});
    }
  }, 1_000);
  expiry.unref();
  const done = (async () => {
    try {
      while (!options.signal.aborted && !permanentlyDenied) {
        try {
          const snapshot = await options.refresh();
          if (options.signal.aborted) break;
          await options.apply(snapshot);
          if (options.signal.aborted) break;
          if (!snapshot.ownerInOrg) {
            permanentlyDenied = true;
            validUntil = 0;
            await options.unavailable(true);
            break;
          }
          validUntil = now() + REMOTE_AUTHORIZATION_LEASE_MS;
          expired = false;
        } catch (error) {
          if (options.signal.aborted) break;
          if (error instanceof AccountApiError && [401, 403, 404].includes(error.status)) {
            permanentlyDenied = true;
            validUntil = 0;
            await options.unavailable(true);
            break;
          }
        }
        await delay(REMOTE_REVOCATION_POLL_MS * (0.9 + Math.random() * 0.2), undefined, {
          signal: options.signal,
        }).catch(() => {});
      }
    } finally {
      clearInterval(expiry);
    }
  })();
  void done.catch(() => {
    validUntil = 0;
    void options.unavailable(false).catch(() => {});
  });
  return { available, done };
}
