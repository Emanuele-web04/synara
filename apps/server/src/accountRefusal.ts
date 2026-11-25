// FILE: accountRefusal.ts
// Purpose: Recognize account-API refusals however deep a dial or RPC wrapper
//          nested them, so every poller classifies them the same way.
// Layer: Server utility (no IO)

import { AccountApiError } from "@synara/shared/account";

/** The account API's typed error anywhere in a cause chain, if there is one. */
export function findAccountApiError(error: unknown): AccountApiError | undefined {
  for (let value: unknown = error, depth = 0; value && depth < 6; depth++) {
    if (value instanceof AccountApiError) return value;
    value = value instanceof Error ? value.cause : undefined;
  }
  return undefined;
}

/** Any 403 the account service answered, ownership denials included. */
export function isAccountRefusal(error: unknown): boolean {
  return findAccountApiError(error)?.status === 403;
}

/**
 * The owner lacks remote access (no subscription, or not enrolled while access
 * is test-only). Unlike an ownership denial, this keeps device trust and can
 * clear on its own once the owner gains access.
 */
export function isRemoteAccessRefusal(error: unknown): boolean {
  const refusal = findAccountApiError(error);
  return (
    refusal?.status === 403 &&
    (refusal.code === "subscription_required" ||
      (refusal.code === "not_host_owner" &&
        refusal.message === "Remote test access is not enabled for this account"))
  );
}
