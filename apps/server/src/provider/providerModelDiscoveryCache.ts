import type { ProviderListModelsInput, ProviderListModelsResult } from "@synara/contracts";
import { Deferred, Effect, Exit, Option } from "effect";

import { ProviderAdapterRequestError } from "./Errors.ts";

/** A successful catalog is served without touching the adapter for this long. */
export const PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS = 30 * 60_000;
const MANUAL_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * After the fresh window a catalog is still served immediately (marked
 * `cached: true`) while a background revalidation runs. Entries older than
 * this are dropped so a long-uninstalled CLI does not haunt the picker forever.
 */
export const PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS = 24 * 60 * 60_000;
// failed/empty discovery replays for this long — turns "retry 3x with backoff" from four process spawns into one
export const PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS = 30_000;
// hard ceiling: some adapters have no internal timeout — keeps every provider under the 60s RPC timeout so the client sees a real error
export const PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = 45_000;
export const PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES = 64;

export interface ProviderModelDiscoveryCacheKey {
  readonly provider: ProviderListModelsInput["provider"];
  readonly instanceId: string | null;
  readonly binaryPath: string | null;
  readonly homePath: string | null;
  readonly shadowHomePath: string | null;
  readonly accountId: string | null;
  readonly apiEndpoint: string | null;
  readonly agentDir: string | null;
  readonly serverUrl: string | null;
  readonly serverPasswordKey: string | null;
  readonly experimentalWebSockets: boolean;
  readonly environmentKey: string | null;
  readonly cwd: string | null;
  /** Claude catalogs depend on the installed CLI version, even at the same path. */
  readonly runtimeVersion?: string | null;
}

function hashCacheComponent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function environmentFingerprint(
  environment: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!environment || Object.keys(environment).length === 0) {
    return null;
  }
  return JSON.stringify(
    Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, hashCacheComponent(value)]),
  );
}

export interface ProviderModelDiscoveryCache<E> {
  // discover always runs detached — a disconnecting client never aborts a discovery other callers wait on
  readonly lookup: (
    key: ProviderModelDiscoveryCacheKey,
    discover: Effect.Effect<ProviderListModelsResult, E>,
    refresh?: ProviderListModelsInput["refresh"],
  ) => Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError>;
  readonly clear: () => void;
  readonly size: () => number;
}

interface CatalogEntry {
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
}

interface FailureEntry {
  readonly exit: Exit.Exit<ProviderListModelsResult, unknown>;
  readonly storedAt: number;
}

type DiscoveryExit<E> = Exit.Exit<ProviderListModelsResult, E | ProviderAdapterRequestError>;

export function providerModelDiscoveryCacheKey(
  input: ProviderListModelsInput,
): ProviderModelDiscoveryCacheKey {
  return {
    provider: input.provider,
    instanceId: input.instanceId ?? null,
    binaryPath: input.binaryPath ?? null,
    homePath: input.homePath ?? null,
    shadowHomePath: input.shadowHomePath ?? null,
    accountId: input.accountId ?? null,
    apiEndpoint: input.apiEndpoint ?? null,
    agentDir: input.agentDir ?? null,
    serverUrl: input.serverUrl ?? null,
    serverPasswordKey: input.serverPassword ? hashCacheComponent(input.serverPassword) : null,
    experimentalWebSockets: input.experimentalWebSockets === true,
    environmentKey: environmentFingerprint(input.environment),
    cwd: input.cwd ?? null,
  };
}

/**
 * Stable serialization for a cache key. This is the on-disk contract for the
 * persisted catalog snapshot (providerModelCatalogCache.ts), so field order
 * here is a file format, not an implementation detail. Snapshots written with
 * an older field list simply miss and fall back to fresh discovery.
 */
export const serializeProviderModelDiscoveryCacheKey = (
  key: ProviderModelDiscoveryCacheKey,
): string =>
  JSON.stringify([
    key.provider,
    key.instanceId,
    key.binaryPath,
    key.homePath,
    key.shadowHomePath,
    key.accountId,
    key.apiEndpoint,
    key.agentDir,
    key.serverUrl,
    key.serverPasswordKey,
    key.experimentalWebSockets,
    key.environmentKey,
    key.cwd,
    ...(key.runtimeVersion !== undefined ? [key.runtimeVersion] : []),
  ]);

// only a non-empty error-free catalog is worth caching as good — erroring fallbacks and empty lists replay briefly so the next real attempt isn't delayed
const isUsableCatalog = (result: ProviderListModelsResult): boolean =>
  result.models.length > 0 && result.error === undefined;

export interface PersistedModelCatalogEntryInput {
  /** Serialized ProviderModelDiscoveryCacheKey — the map key. */
  readonly key: string;
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
}

export function makeProviderModelDiscoveryCache<E>(options?: {
  readonly now?: () => number;
  readonly freshTtlMs?: number;
  readonly staleTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
  /**
   * Snapshots hydrated from disk (providerModelCatalogCache.ts). `storedAt` is
   * preserved so fresh/stale windows stay honest across restarts.
   */
  readonly persistedCatalogs?: ReadonlyArray<PersistedModelCatalogEntryInput>;
  /** Invoked with the full catalog snapshot after every mutation (store, expiry, clear). */
  readonly onCatalogsChanged?: (entries: ReadonlyArray<PersistedModelCatalogEntryInput>) => void;
}): ProviderModelDiscoveryCache<E> {
  const now = options?.now ?? (() => Date.now());
  const freshTtlMs = options?.freshTtlMs ?? PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS;
  const staleTtlMs = options?.staleTtlMs ?? PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS;
  const failureTtlMs = options?.failureTtlMs ?? PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS;
  const maxEntries = options?.maxEntries ?? PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES;

  const catalogs = new Map<string, CatalogEntry>();
  const failures = new Map<string, FailureEntry>();
  const inflight = new Map<string, Deferred.Deferred<ProviderListModelsResult, unknown>>();

  const emitCatalogsChanged = () => {
    try {
      options?.onCatalogsChanged?.(
        [...catalogs.entries()].map(([key, entry]) => ({
          key,
          result: entry.result,
          storedAt: entry.storedAt,
        })),
      );
    } catch {
      // The listener persists snapshots; a throwing listener must not strand
      // the deferred waiters that applyExit resolves right after this call.
    }
  };

  // Hydrate from the persisted snapshot; entries already past the stale TTL are
  // dead on arrival and dropped (emitting once so the file is cleaned too).
  const bootedAt = now();
  let droppedPersisted = false;
  for (const entry of options?.persistedCatalogs ?? []) {
    if (bootedAt - entry.storedAt > staleTtlMs) {
      droppedPersisted = true;
      continue;
    }
    catalogs.set(entry.key, { result: entry.result, storedAt: entry.storedAt });
    while (catalogs.size > maxEntries) {
      const oldest = catalogs.keys().next().value;
      if (oldest === undefined) break;
      catalogs.delete(oldest);
      droppedPersisted = true;
    }
  }
  if (droppedPersisted) emitCatalogsChanged();

  const readCatalog = (serialized: string, at: number): CatalogEntry | undefined => {
    const entry = catalogs.get(serialized);
    if (entry === undefined) return undefined;
    if (at - entry.storedAt > staleTtlMs) {
      catalogs.delete(serialized);
      emitCatalogsChanged();
      return undefined;
    }
    return entry;
  };

  const readFailure = (serialized: string, at: number): FailureEntry | undefined => {
    const entry = failures.get(serialized);
    if (entry === undefined) return undefined;
    if (at - entry.storedAt > failureTtlMs) {
      failures.delete(serialized);
      return undefined;
    }
    return entry;
  };

  const storeCatalog = (serialized: string, result: ProviderListModelsResult, at: number) => {
    failures.delete(serialized);
    // Re-insert so Map iteration order doubles as an LRU order.
    catalogs.delete(serialized);
    catalogs.set(serialized, { result: { ...result, cached: false }, storedAt: at });
    while (catalogs.size > maxEntries) {
      const oldest = catalogs.keys().next().value;
      if (oldest === undefined) break;
      catalogs.delete(oldest);
    }
    emitCatalogsChanged();
  };

  const storeFailure = (
    serialized: string,
    exit: Exit.Exit<ProviderListModelsResult, unknown>,
    at: number,
  ) => {
    failures.set(serialized, { exit, storedAt: at });
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  };

  const applyExit = (serialized: string, exit: DiscoveryExit<E>) => {
    const at = now();
    if (Exit.isSuccess(exit) && isUsableCatalog(exit.value)) {
      storeCatalog(serialized, exit.value, at);
      return;
    }
    // An error-free empty response is authoritative: do not keep offering
    // models the provider has removed. Replay it briefly before rediscovery.
    if (Exit.isSuccess(exit) && exit.value.error === undefined && catalogs.delete(serialized)) {
      emitCatalogsChanged();
    }
    storeFailure(serialized, exit, at);
  };

  // the discovery runs on a detached fiber so it outlives the requesting RPC and every concurrent caller sees the same exit
  const startDiscovery = (
    key: ProviderModelDiscoveryCacheKey,
    serialized: string,
    discover: Effect.Effect<ProviderListModelsResult, E>,
  ): Effect.Effect<Deferred.Deferred<ProviderListModelsResult, unknown>> =>
    Effect.gen(function* () {
      const existing = inflight.get(serialized);
      if (existing !== undefined) return existing;
      const deferred = yield* Deferred.make<ProviderListModelsResult, unknown>();
      inflight.set(serialized, deferred);
      const run = discover.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: key.provider,
                  method: "models/list",
                  detail: `Model discovery timed out after ${Math.round(timeoutMs / 1000)}s.`,
                }),
              ),
        ),
        Effect.exit,
        Effect.flatMap((exit) => {
          inflight.delete(serialized);
          applyExit(serialized, exit as DiscoveryExit<E>);
          return Deferred.done(deferred, exit);
        }),
      );
      yield* Effect.forkDetach(run);
      return deferred;
    });

  const awaitDiscovery = (
    deferred: Deferred.Deferred<ProviderListModelsResult, unknown>,
  ): Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError> =>
    Deferred.await(deferred) as Effect.Effect<
      ProviderListModelsResult,
      E | ProviderAdapterRequestError
    >;

  const lookup: ProviderModelDiscoveryCache<E>["lookup"] = (key, discover, refresh) =>
    Effect.gen(function* () {
      const serialized = serializeProviderModelDiscoveryCacheKey(key);
      const at = now();
      const entry = readCatalog(serialized, at);
      const failure = readFailure(serialized, at);
      if (refresh !== undefined) {
        const pending = inflight.get(serialized);
        if (pending !== undefined) return yield* awaitDiscovery(pending);
        if (failure !== undefined) return yield* failure.exit as DiscoveryExit<E>;
        const freshWindow = refresh === "now" ? MANUAL_REFRESH_MIN_INTERVAL_MS : freshTtlMs;
        if (entry !== undefined && at - entry.storedAt <= freshWindow) {
          return { ...entry.result, cached: true };
        }
        return yield* awaitDiscovery(yield* startDiscovery(key, serialized, discover));
      }
      if (entry !== undefined) {
        if (at - entry.storedAt <= freshTtlMs) {
          return { ...entry.result, cached: true };
        }
        // Stale-while-revalidate: answer now, refresh behind the caller.
        if (failure === undefined) {
          yield* startDiscovery(key, serialized, discover);
        }
        return { ...entry.result, cached: true };
      }
      const pending = inflight.get(serialized);
      if (pending !== undefined) {
        return yield* awaitDiscovery(pending);
      }
      if (failure !== undefined) {
        return yield* failure.exit as DiscoveryExit<E>;
      }
      const deferred = yield* startDiscovery(key, serialized, discover);
      return yield* awaitDiscovery(deferred);
    });

  return {
    lookup,
    clear: () => {
      const hadCatalogs = catalogs.size > 0;
      catalogs.clear();
      failures.clear();
      if (hadCatalogs) emitCatalogsChanged();
    },
    size: () => catalogs.size,
  };
}
