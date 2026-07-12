// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — per-provider TTL cache, defensive
// batch fetch (one failure never blocks the others), and enrichment of Codex/Claude live
// snapshots with the locally-derived token-total usage lines. Exposes both a plain async API
// (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderKind,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "../config";
import { loadLocalProviderUsageLines } from "../providerUsageSnapshot";
import { errorSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";

const LIVE_USAGE_TTL_MS = 60_000;

// Providers whose live snapshot is enriched with on-disk token-total lines (24h/7d/30d).
const LOCAL_ARCHIVE_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

interface CacheEntry {
  expiresAtMs: number;
  value: ServerProviderUsageSnapshot | null;
  pending: Promise<ServerProviderUsageSnapshot> | null;
}

const liveUsageCache = new Map<string, CacheEntry>();

function buildContext(): ProviderUsageContext {
  return {
    homeDir: "",
    env: process.env,
    platform: process.platform,
    nowMs: Date.now(),
  };
}

async function fetchProviderUsageCached(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
  options: { forceRefresh?: boolean } = {},
): Promise<ServerProviderUsageSnapshot | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher) {
    return null;
  }

  const cacheKey = `${provider}:${ctx.homeDir}`;
  const existing = liveUsageCache.get(cacheKey);
  if (!options.forceRefresh && existing && existing.value && existing.expiresAtMs > ctx.nowMs) {
    return existing.value;
  }
  if (!options.forceRefresh && existing?.pending) {
    return existing.pending;
  }

  const pending = fetcher
    .fetch(ctx)
    .catch(() =>
      errorSnapshot(provider, ctx.nowMs, "live-usage", "Usage fetch failed unexpectedly."),
    )
    .then((value) => {
      const status = value.status ?? "ok";
      liveUsageCache.set(cacheKey, {
        expiresAtMs: status === "ok" ? Date.now() + LIVE_USAGE_TTL_MS : 0,
        value,
        pending: null,
      });
      return value;
    });

  liveUsageCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    value: existing?.value ?? null,
    pending,
  });

  return pending;
}

async function enrichWithLocalUsage(
  snapshot: ServerProviderUsageSnapshot,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot> {
  if ((snapshot.status ?? "ok") !== "ok" || !LOCAL_ARCHIVE_PROVIDERS.has(snapshot.provider)) {
    return snapshot;
  }
  const localLines = await loadLocalProviderUsageLines({
    provider: snapshot.provider,
    homeDir: ctx.homeDir,
  });
  if (localLines.length === 0) {
    return snapshot;
  }
  return { ...snapshot, usageLines: [...snapshot.usageLines, ...localLines] };
}

/** Plain async batch fetch for supported providers. Never throws. */
export async function collectProviderUsageSnapshots(
  ctx: ProviderUsageContext,
  options: { forceRefresh?: boolean; provider?: ProviderKind } = {},
): Promise<ServerProviderUsageSnapshot[]> {
  const providers = options.provider
    ? ([options.provider] as ProviderKind[])
    : (Object.keys(PROVIDER_USAGE_FETCHERS) as ProviderKind[]);
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const snapshot = await fetchProviderUsageCached(provider, ctx, options);
      return snapshot ? enrichWithLocalUsage(snapshot, ctx) : null;
    }),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== null);
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  return yield* Effect.tryPromise({
    try: () =>
      collectProviderUsageSnapshots(
        {
          ...buildContext(),
          homeDir: serverConfig.homeDir,
        },
        {
          forceRefresh: input.forceRefresh === true,
          ...(input.provider ? { provider: input.provider } : {}),
        },
      ),
    catch: () => [] as unknown as ServerListProviderUsageResult,
  });
});
