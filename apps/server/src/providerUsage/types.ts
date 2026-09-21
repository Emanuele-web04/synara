// fetchers never throw — they resolve a snapshot; a fetcher redeeming a refresh token must persist the rotated pair back to the CLI's store (single-use tokens)

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";

export interface ProviderUsageContext {
  readonly homeDir: string;
  /** lets fetchers honor CODEX_HOME, CLAUDE_CONFIG_DIR, etc. */
  readonly env: NodeJS.ProcessEnv;
  /** keychain reads only run on darwin */
  readonly platform: NodeJS.Platform;
  /** injectable "now" for token-expiry checks in tests */
  readonly nowMs: number;
  /** defaults to "claude" */
  readonly claudeBinaryPath?: string;
  /** defaults to "codex" */
  readonly codexBinaryPath?: string;
}

export interface ProviderUsageFetcher {
  readonly provider: ProviderKind;
  /** a changed identity invalidates the orchestration cache early; null disables caching when identity can't be read safely */
  readonly cacheKey?: (ctx: ProviderUsageContext) => Promise<string | null>;
  /** resolve credentials and fetch live usage; never throws */
  fetch(ctx: ProviderUsageContext): Promise<ServerProviderUsageSnapshot>;
}
