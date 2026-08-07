// FILE: providerUsage/types.ts
// Purpose: Shared contract for the server-side live provider-usage fetchers. Each provider
// implements ProviderUsageFetcher; the registry maps ProviderKind -> fetcher. Fetchers must
// never throw — they resolve to a snapshot whose `status` describes the outcome. Token
// freshness is the owning CLI's job where possible (Claude delegates to `claude auth status`);
// a fetcher that redeems a refresh token itself must persist the rotated pair back to the
// CLI's credential store, because providers rotate single-use refresh tokens.

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
  /** Claude CLI binary (settings.providers.claudeAgent.binaryPath); defaults to "claude". */
  readonly claudeBinaryPath?: string;
}

export interface ProviderUsageFetcher {
  readonly provider: ProviderKind;
  /** Resolve credentials and fetch live usage. Never throws. */
  fetch(ctx: ProviderUsageContext): Promise<ServerProviderUsageSnapshot>;
}
