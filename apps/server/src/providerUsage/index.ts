// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — defensive batch fetch (one failure never
// blocks the others), per-provider snapshot caching with single-flight coalescing, and enrichment
// of Codex/Claude live snapshots with the locally-derived token-total usage lines. Exposes both a
// plain async API (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderKind,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "../config";
import { buildProviderChildEnvironment, type ProviderChildKind } from "../providerChildEnvironment";
import { ServerSettingsService } from "../serverSettings";
import { loadLocalProviderUsageLines } from "../providerUsageSnapshot";
import { errorSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";

// Providers whose live snapshot is enriched with on-disk token-total lines (24h/7d/30d).
const LOCAL_ARCHIVE_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

const providerChildKind = (provider: ProviderKind): ProviderChildKind =>
  provider === "claudeAgent" ? "claude" : provider;

function buildContext(): ProviderUsageContext {
  return {
    homeDir: "",
    env: process.env,
    platform: process.platform,
    nowMs: Date.now(),
  };
}

async function fetchProviderUsage(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher) {
    return null;
  }

  const providerContext: ProviderUsageContext = {
    ...ctx,
    env: buildProviderChildEnvironment({
      provider: providerChildKind(provider),
      baseEnv: ctx.env,
    }),
  };
  return fetcher
    .fetch(providerContext)
    .catch(() =>
      errorSnapshot(provider, ctx.nowMs, "live-usage", "Usage fetch failed unexpectedly."),
    );
}

// Every UI surface (header chip, branch toolbar, settings panel) plus their periodic refetches
// funnels through this cache, so one browser tab doesn't hammer provider endpoints — or spawn
// `claude auth status` processes — once per surface. Fresh snapshots are served from memory,
// concurrent requests for the same provider coalesce into a single fetch, and `forceRefresh`
// (the settings panel's explicit refresh button) bypasses the TTL but still joins an in-flight
// fetch. Degraded snapshots (errors, re-served last-good data) expire faster so recovery is
// picked up quickly. Keyed by ProviderKind, so the cache is inherently bounded.
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_CACHE_DEGRADED_TTL_MS = 60 * 1000;

interface CachedSnapshot {
  snapshot: ServerProviderUsageSnapshot;
  fetchedAtMs: number;
}

const snapshotCache = new Map<ProviderKind, CachedSnapshot>();
const inFlightFetches = new Map<ProviderKind, Promise<ServerProviderUsageSnapshot | null>>();

const snapshotCacheTtlMs = (snapshot: ServerProviderUsageSnapshot): number =>
  (snapshot.status ?? "ok") === "error" || snapshot.stale === true
    ? SNAPSHOT_CACHE_DEGRADED_TTL_MS
    : SNAPSHOT_CACHE_TTL_MS;

/** Test-only: drop the snapshot cache and any in-flight coalescing state. */
export function __resetProviderUsageCacheForTests(): void {
  snapshotCache.clear();
  inFlightFetches.clear();
}

async function getProviderUsageSnapshot(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
  forceRefresh: boolean,
): Promise<ServerProviderUsageSnapshot | null> {
  if (!forceRefresh) {
    const cached = snapshotCache.get(provider);
    if (cached && ctx.nowMs - cached.fetchedAtMs < snapshotCacheTtlMs(cached.snapshot)) {
      return cached.snapshot;
    }
  }

  const pending = inFlightFetches.get(provider);
  if (pending) {
    return pending;
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchProviderUsage(provider, ctx);
    const enriched = snapshot ? await enrichWithLocalUsage(snapshot, ctx) : null;
    if (enriched) {
      snapshotCache.set(provider, { snapshot: enriched, fetchedAtMs: ctx.nowMs });
    }
    return enriched;
  })();
  inFlightFetches.set(provider, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightFetches.delete(provider);
  }
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
    providers.map((provider) =>
      getProviderUsageSnapshot(provider, ctx, options.forceRefresh === true),
    ),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== null);
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  return yield* Effect.tryPromise({
    try: () =>
      collectProviderUsageSnapshots(
        {
          ...buildContext(),
          homeDir: serverConfig.homeDir,
          claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
        },
        {
          forceRefresh: input.forceRefresh === true,
          ...(input.provider ? { provider: input.provider } : {}),
        },
      ),
    catch: () => [] as unknown as ServerListProviderUsageResult,
  });
});
