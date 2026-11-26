// FILE: usageHubs.ts
// Purpose: Shared naming and flattening for accounts pooled on CLIProxyAPI usage hubs, so the
//          sidebar rings, the Environment panel, and Settings all label them the same way.

import type { ServerUsageHub, ServerUsageHubAccount } from "@synara/contracts";

export interface UsageHubAccountEntry {
  readonly hub: ServerUsageHub;
  readonly account: ServerUsageHubAccount;
  /** `alpha@example.com (Home hub)`: the account, then the hub it sits on. */
  readonly name: string;
}

export function usageHubAccountName(hub: ServerUsageHub, account: ServerUsageHubAccount): string {
  return `${account.email ?? account.id} (${hub.label})`;
}

/** Every pooled account across hubs, in hub order then the hub's own account order. */
export function flattenUsageHubAccounts(
  hubs: ReadonlyArray<ServerUsageHub> | undefined,
): ReadonlyArray<UsageHubAccountEntry> {
  return (hubs ?? []).flatMap((hub) =>
    hub.accounts.map((account) => ({ hub, account, name: usageHubAccountName(hub, account) })),
  );
}

/** Hub account keys (`ServerUsageHubAccount.key`) are minted by the server with this prefix. */
export const USAGE_HUB_ACCOUNT_KEY_PREFIX = "hub_";
