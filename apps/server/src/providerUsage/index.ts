// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — defensive batch fetch (one failure never
// blocks the others), per-provider snapshot caching with single-flight coalescing, and enrichment
// of Codex/Claude live snapshots with the locally-derived token-total usage lines. Exposes both a
// plain async API (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderKind,
  ServerConsumeCodexResetCreditInput,
  ServerConsumeCodexResetCreditResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Effect } from "effect";
import nodePath from "node:path";

import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
} from "@synara/shared/providerInstances";

import { ServerConfig } from "../config";
import { resolveBaseCodexHomePath } from "../codexHomePaths";
import { prepareCodexAuthTracking } from "../codexProcessEnv";
import { expandProviderAccountHomePath } from "../providerAccountHomePath";
import { buildClaudeInstanceProcessEnv } from "../provider/claudeEnvironment";
import {
  buildProviderProcessEnv,
  type ProviderProcessEnvDriver,
} from "../provider/providerProcessEnv";
import { consumeCodexResetCredit } from "./codexResetCredits";
import { buildProviderChildEnvironment, type ProviderChildKind } from "../providerChildEnvironment";
import { ServerSettingsService } from "../serverSettings";
import { loadLocalProviderUsageLines } from "../providerUsageSnapshot";
import { errorSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";
import { credentialFingerprint } from "./credentials";

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
  providerContext: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher) {
    return null;
  }

  return fetcher
    .fetch(providerContext)
    .catch(() =>
      errorSnapshot(
        provider,
        providerContext.nowMs,
        "live-usage",
        "Usage fetch failed unexpectedly.",
      ),
    );
}

function buildProviderContext(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): ProviderUsageContext {
  return {
    ...ctx,
    env: buildProviderChildEnvironment({
      provider: providerChildKind(provider),
      baseEnv: ctx.env,
    }),
  };
}

// Every UI surface (header chip, branch toolbar, settings panel) plus their periodic refetches
// funnels through this cache, so one browser tab doesn't hammer provider endpoints — or spawn
// `claude auth status` processes — once per surface. Fresh snapshots are served from memory,
// concurrent requests for the same provider coalesce into a single fetch, and `forceRefresh`
// (the settings panel's explicit refresh button) bypasses the TTL but still joins an in-flight
// fetch. Degraded snapshots (errors, re-served last-good data) expire faster so recovery is
// picked up quickly. Instance scopes are pruned when their account is removed or disabled.
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_CACHE_DEGRADED_TTL_MS = 60 * 1000;

interface CachedSnapshot {
  snapshot: ServerProviderUsageSnapshot;
  fetchedAtMs: number;
  credentialKey: string;
}

interface InFlightSnapshot {
  credentialKey: string;
  promise: Promise<ServerProviderUsageSnapshot | null>;
}

const snapshotCache = new Map<string, CachedSnapshot>();
const inFlightFetches = new Map<string, InFlightSnapshot>();
const snapshotCacheGenerations = new Map<string, symbol>();

const snapshotCacheTtlMs = (snapshot: ServerProviderUsageSnapshot): number =>
  snapshot.stale === true
    ? 0
    : (snapshot.status ?? "ok") === "error" || (snapshot.status ?? "ok") === "needs-auth"
      ? SNAPSHOT_CACHE_DEGRADED_TTL_MS
      : SNAPSHOT_CACHE_TTL_MS;

async function resolveCredentialKey(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): Promise<string | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  try {
    const credentialKey = fetcher?.cacheKey ? await fetcher.cacheKey(ctx) : provider;
    if (credentialKey === null || !ctx.instanceId) {
      return credentialKey;
    }
    // A renamed/reconfigured route can retain its credential identity while its
    // archive root, binary or reset permission changes. Keep those reads coherent,
    // retaining only a non-secret fingerprint of the launch context.
    const contextKey = credentialFingerprint(
      JSON.stringify({
        env: ctx.env,
        homeDir: ctx.homeDir,
        codexBinaryPath: ctx.codexBinaryPath,
        claudeBinaryPath: ctx.claudeBinaryPath,
        isolateCredentials: ctx.isolateCredentials,
        disableResetCredits: ctx.disableResetCredits,
        skipLocalUsage: ctx.skipLocalUsage,
        localUsageHomePath: ctx.localUsageHomePath,
      }),
    );
    return `${credentialKey}:${contextKey}`;
  } catch {
    return null;
  }
}

/** Test-only: drop the snapshot cache and any in-flight coalescing state. */
export function __resetProviderUsageCacheForTests(): void {
  snapshotCache.clear();
  inFlightFetches.clear();
  snapshotCacheGenerations.clear();
}

function invalidateProviderUsageScopes(scopes: ReadonlyArray<string>): void {
  for (const scope of scopes) {
    snapshotCache.delete(scope);
    inFlightFetches.delete(scope);
    snapshotCacheGenerations.delete(scope);
  }
}

function invalidateProviderUsageSnapshots(providers: ReadonlyArray<ProviderKind>): void {
  invalidateProviderUsageScopes(
    [...snapshotCacheGenerations.keys()].filter((scope) =>
      providers.some((provider) => scope === provider || scope.startsWith(`${provider}:`)),
    ),
  );
}

async function getProviderUsageSnapshot(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
  forceRefresh: boolean,
): Promise<ServerProviderUsageSnapshot | null> {
  const scope = ctx.instanceId ? `${provider}:${ctx.instanceId}` : provider;
  const cacheGeneration = snapshotCacheGenerations.get(scope) ?? Symbol();
  snapshotCacheGenerations.set(scope, cacheGeneration);
  const providerContext = buildProviderContext(provider, ctx);
  const credentialKey = await resolveCredentialKey(provider, providerContext);
  const pending = inFlightFetches.get(scope);
  if (credentialKey !== null && pending?.credentialKey === credentialKey) {
    return pending.promise;
  }

  if (!forceRefresh && credentialKey !== null) {
    const cached = snapshotCache.get(scope);
    if (
      cached &&
      cached.credentialKey === credentialKey &&
      ctx.nowMs - cached.fetchedAtMs < snapshotCacheTtlMs(cached.snapshot)
    ) {
      return cached.snapshot;
    }
  }

  const fetchPromise = (async () => {
    const snapshot = await fetchProviderUsage(provider, providerContext);
    const enriched = snapshot
      ? await enrichWithLocalUsage(
          {
            ...snapshot,
            ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
            ...(snapshot.resetCredits && ctx.disableResetCredits
              ? { resetCredits: { ...snapshot.resetCredits, canUse: false } }
              : {}),
          },
          ctx,
        )
      : null;
    const refreshedCredentialKey = await resolveCredentialKey(provider, providerContext);
    if (
      enriched &&
      credentialKey !== null &&
      refreshedCredentialKey === credentialKey &&
      snapshotCacheGenerations.get(scope) === cacheGeneration
    ) {
      const current = snapshotCache.get(scope);
      const hasFreshHealthySnapshot =
        current?.credentialKey === credentialKey &&
        snapshotCacheTtlMs(current.snapshot) === SNAPSHOT_CACHE_TTL_MS &&
        ctx.nowMs - current.fetchedAtMs < SNAPSHOT_CACHE_TTL_MS;
      const fetchedFailedSnapshot = (enriched.status ?? "ok") === "error";
      if (fetchedFailedSnapshot && hasFreshHealthySnapshot && current) {
        return current.snapshot;
      }
      snapshotCache.set(scope, {
        snapshot: enriched,
        fetchedAtMs: ctx.nowMs,
        credentialKey,
      });
    }
    return enriched;
  })();
  if (credentialKey !== null) {
    inFlightFetches.set(scope, { credentialKey, promise: fetchPromise });
  }
  try {
    return await fetchPromise;
  } finally {
    if (inFlightFetches.get(scope)?.promise === fetchPromise) {
      inFlightFetches.delete(scope);
    }
  }
}

async function enrichWithLocalUsage(
  snapshot: ServerProviderUsageSnapshot,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot> {
  if (
    ctx.skipLocalUsage ||
    (snapshot.status ?? "ok") !== "ok" ||
    !LOCAL_ARCHIVE_PROVIDERS.has(snapshot.provider)
  ) {
    return snapshot;
  }
  const localLines = await loadLocalProviderUsageLines({
    provider: snapshot.provider,
    homeDir: ctx.homeDir,
    ...(ctx.localUsageHomePath ? { homePath: ctx.localUsageHomePath } : {}),
  });
  if (localLines.length === 0) {
    return snapshot;
  }
  return { ...snapshot, usageLines: [...snapshot.usageLines, ...localLines] };
}

/** Plain async batch fetch for supported providers. Never throws. */
export async function collectProviderUsageSnapshots(
  ctx: ProviderUsageContext,
  options: {
    forceRefresh?: boolean;
    provider?: ProviderKind;
    providers?: ReadonlyArray<ProviderKind>;
  } = {},
): Promise<ServerProviderUsageSnapshot[]> {
  const providers = options.provider
    ? ([options.provider] as ProviderKind[])
    : options.providers
      ? [...options.providers]
      : PROVIDER_USAGE_PROVIDERS.filter(
          (provider) => PROVIDER_USAGE_FETCHERS[provider] !== undefined,
        );
  const settled = await Promise.allSettled(
    providers.map((provider) =>
      getProviderUsageSnapshot(provider, ctx, options.forceRefresh === true),
    ),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== null);
}

const GENERIC_USAGE_DRIVERS: Partial<Record<ProviderKind, ProviderProcessEnvDriver>> = {
  cursor: "cursor",
  antigravity: "gemini",
  grok: "grok",
  droid: "kilo",
  opencode: "opencode",
  pi: "pi",
};

function instanceUsageContext(
  instance: ResolvedProviderInstance,
  ctx: ProviderUsageContext,
  stateDir: string,
  baseDir: string,
): ProviderUsageContext {
  const start = providerStartOptionsFromInstance(instance);
  const options = instance.driver === "external" ? undefined : start?.[instance.driver];
  const selectedEnvironment =
    options?.environment === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options.environment).map(([name, value]) => [
            name,
            /(?:_DIR|_HOME|_PATH)$|^HOME$|^USERPROFILE$/u.test(name)
              ? expandProviderAccountHomePath(value, ctx.homeDir)
              : value,
          ]),
        );
  let env = { ...ctx.env, ...selectedEnvironment };
  let isolateCredentials = !instance.isDefault || selectedEnvironment !== undefined;
  let localUsageHomePath: string | undefined;
  let skipLocalUsage = !instance.isDefault;
  let disableResetCredits = !instance.isDefault;

  if (instance.driver === "codex") {
    const codex = start?.codex;
    const homePath = codex?.homePath
      ? expandProviderAccountHomePath(codex.homePath, ctx.homeDir)
      : undefined;
    const shadowHomePath = codex?.shadowHomePath
      ? expandProviderAccountHomePath(codex.shadowHomePath, ctx.homeDir)
      : undefined;
    isolateCredentials ||= Boolean(homePath || shadowHomePath || codex?.accountId);
    disableResetCredits ||= Boolean(
      homePath ||
      shadowHomePath ||
      codex?.accountId ||
      selectedEnvironment?.CODEX_HOME ||
      selectedEnvironment?.HOME ||
      selectedEnvironment?.XDG_CONFIG_HOME ||
      (codex?.binaryPath && codex.binaryPath !== ctx.codexBinaryPath),
    );
    // Use the runtime's authoritative auth boundary, including aliases of the
    // ambient home and environment-only accounts that own private overlay auth.
    env.CODEX_HOME =
      !instance.isDefault || codex?.accountId || shadowHomePath
        ? nodePath.dirname(
            prepareCodexAuthTracking({
              env: { ...env, SYNARA_HOME: baseDir },
              ...(homePath ? { homePath } : {}),
              ...(shadowHomePath ? { shadowHomePath } : {}),
              ...(codex?.accountId ? { accountId: codex.accountId } : {}),
            }).authoritativeAuthFilePath,
          )
        : resolveBaseCodexHomePath(env, homePath);
    localUsageHomePath = env.CODEX_HOME;
  } else if (instance.driver === "claudeAgent") {
    env = buildClaudeInstanceProcessEnv(start?.claudeAgent?.homePath, selectedEnvironment, {
      homeDir: ctx.homeDir,
      isolationRootDir: stateDir,
      providerInstanceId: instance.instanceId,
      platform: ctx.platform,
      baseEnvironment: ctx.env,
    });
    isolateCredentials ||=
      Boolean(start?.claudeAgent?.homePath || env.CLAUDE_CONFIG_DIR) ||
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined;
    // A custom config/secure-store root is not the default ~/.claude archive.
    skipLocalUsage ||=
      isolateCredentials || Boolean(env.CLAUDE_CONFIG_DIR || env.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  } else {
    const genericDriver = GENERIC_USAGE_DRIVERS[instance.driver];
    if (genericDriver) {
      env = buildProviderProcessEnv({
        driver: genericDriver,
        ...(selectedEnvironment === undefined ? {} : { environment: selectedEnvironment }),
        ...(instance.isDefault ? {} : { instanceId: instance.instanceId }),
        env: ctx.env,
        homeDir: ctx.homeDir,
        isolationRootDir: stateDir,
        platform: ctx.platform,
      });
      if (instance.driver === "pi" && start?.pi?.agentDir) {
        env.PI_CODING_AGENT_DIR = expandProviderAccountHomePath(start.pi.agentDir, ctx.homeDir);
      }
    } else if (instance.driver === "devin" && isolateCredentials) {
      // Matches Devin's terminal profile boundary; it has no shared process-home builder.
      const homeDir =
        selectedEnvironment?.HOME ||
        nodePath.join(
          stateDir,
          "provider-homes",
          "devin",
          `instance-${Buffer.from(instance.instanceId, "utf8").toString("hex")}`,
        );
      env = buildProviderChildEnvironment({
        provider: "devin",
        baseEnv: {},
        overrides: {
          ...selectedEnvironment,
          HOME: homeDir,
          USERPROFILE: homeDir,
        },
      });
    }
  }

  return {
    ...ctx,
    instanceId: instance.instanceId,
    env,
    homeDir: env.HOME?.trim() || ctx.homeDir,
    isolateCredentials,
    skipLocalUsage,
    disableResetCredits,
    ...(localUsageHomePath ? { localUsageHomePath } : {}),
    ...(start?.codex?.binaryPath ? { codexBinaryPath: start.codex.binaryPath } : {}),
    ...(start?.claudeAgent?.binaryPath ? { claudeBinaryPath: start.claudeAgent.binaryPath } : {}),
  };
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const instances = deriveProviderInstances(settings).filter(
    (instance) => instance.enabled && PROVIDER_USAGE_FETCHERS[instance.driver] !== undefined,
  );
  const activeScopes = new Set(
    instances.map((instance) => `${instance.driver}:${instance.instanceId}`),
  );
  invalidateProviderUsageScopes(
    [...snapshotCacheGenerations.keys()].filter(
      (scope) => scope.includes(":") && !activeScopes.has(scope),
    ),
  );
  const selected = input.provider
    ? instances.filter((instance) => instance.driver === input.provider)
    : instances;

  return yield* Effect.tryPromise({
    try: async () => {
      const ctx = {
        ...buildContext(),
        homeDir: serverConfig.homeDir,
        claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
        codexBinaryPath: settings.providers.codex.binaryPath,
      };
      const settled = await Promise.allSettled(
        selected.map(async (instance) =>
          getProviderUsageSnapshot(
            instance.driver,
            instanceUsageContext(instance, ctx, serverConfig.stateDir, serverConfig.baseDir),
            input.forceRefresh === true,
          ),
        ),
      );
      return settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value ? [result.value] : [];
        const instance = selected[index]!;
        return [
          {
            ...errorSnapshot(
              instance.driver,
              ctx.nowMs,
              "live-usage",
              "Usage could not be read for this account.",
            ),
            instanceId: instance.instanceId,
          },
        ];
      });
    },
    catch: () => [] as unknown as ServerListProviderUsageResult,
  });
});

/** Spend one banked Codex reset, then drop the cached Codex snapshot so the
 * next read reflects the spend. A spent reset shows up as a fresh quota read. */
export const consumeCodexResetCreditEffect = Effect.fn(function* (
  input: ServerConsumeCodexResetCreditInput,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const outcome = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await consumeCodexResetCredit({
          binaryPath: settings.providers.codex.binaryPath,
          env: buildProviderChildEnvironment({ provider: "codex", baseEnv: process.env }),
          cwd: serverConfig.homeDir,
          ...input,
        });
      } finally {
        // A lost reply may still have spent the reset. Never retain pre-attempt quota data.
        invalidateProviderUsageSnapshots(["codex"]);
      }
    },
    catch: (cause) => cause,
  });
  return { outcome } as ServerConsumeCodexResetCreditResult;
});
