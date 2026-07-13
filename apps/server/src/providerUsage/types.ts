// FILE: providerUsage/types.ts
// Purpose: Shared contract for the server-side live provider-usage fetchers. Each provider
// implements ProviderUsageFetcher; the registry maps ProviderKind -> fetcher. Fetchers must
// never throw — they resolve to a snapshot whose `status` describes the outcome. Providers
// with short-lived OAuth tokens may refresh through their own token endpoint.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";

export interface ProviderUsageContext {
  /** Resolved user home directory (ServerConfig.homeDir). */
  readonly homeDir: string;
  /** Process environment (lets fetchers honor CODEX_HOME, CLAUDE_CONFIG_DIR, etc.). */
  readonly env: NodeJS.ProcessEnv;
  /** Host platform; keychain reads only run on darwin. */
  readonly platform: NodeJS.Platform;
  /** Reference "now" in epoch ms, used for token-expiry checks (kept injectable for tests). */
  readonly nowMs: number;
}

export interface ProviderUsageFetcher {
  readonly provider: ProviderKind;
  /** Resolve credentials and fetch live usage. Never throws. */
  fetch(ctx: ProviderUsageContext): Promise<ServerProviderUsageSnapshot>;
}
