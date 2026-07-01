/**
 * Provider status cache helpers.
 *
 * Keeps provider readiness snapshots durable across restarts without making
 * the cache authoritative over fresh CLI probes.
 *
 * @module providerStatusCache
 */
import {
  ServerProviderStatus,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";

const PROVIDER_STATUS_CACHE_IDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<ServerProviderStatus["provider"]>;

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderStatus),
);

const providerOrderRank = (provider: ServerProviderStatus["provider"]): number => {
  const rank = (PROVIDER_STATUS_CACHE_IDS as readonly string[]).indexOf(provider);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
};

export const orderProviderStatuses = (
  providers: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> =>
  [...providers].toSorted((left, right) => {
    const rankDelta = providerOrderRank(left.provider) - providerOrderRank(right.provider);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return (left.instanceId ?? left.provider).localeCompare(right.instanceId ?? right.provider);
  });

function normalizeProviderStatusIdentity(status: ServerProviderStatus): ServerProviderStatus {
  return {
    ...status,
    instanceId: status.instanceId ?? defaultInstanceIdForDriver(status.provider),
    driver: status.driver ?? status.provider,
  };
}

export function resolveProviderStatusCachePath(input: {
  readonly stateDir: string;
  readonly provider: ServerProviderStatus["provider"];
  readonly instanceId?: ProviderInstanceId | undefined;
}): string {
  return `${input.stateDir}/provider-status/${input.instanceId ?? input.provider}.json`;
}

// Ignore unreadable or malformed cache entries so the server can still boot
// and fall back to fresh probes or empty state.
export const readProviderStatusCache = (
  filePath: string,
  expected?: {
    readonly provider: ServerProviderStatus["provider"];
    readonly instanceId?: ProviderInstanceId | undefined;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const status = yield* decodeProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider status cache, ignoring", {
            path: filePath,
            issues: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
    if (!status) {
      return undefined;
    }
    const normalizedStatus = normalizeProviderStatusIdentity(status);
    if (!expected) {
      return normalizedStatus;
    }

    const expectedInstanceId = expected.instanceId ?? expected.provider;
    const actualInstanceId = normalizedStatus.instanceId;
    if (
      normalizedStatus.provider === expected.provider &&
      actualInstanceId === expectedInstanceId
    ) {
      return normalizedStatus;
    }

    yield* Effect.logWarning("provider status cache identity mismatch, ignoring", {
      path: filePath,
      expectedProvider: expected.provider,
      expectedInstanceId,
      actualProvider: normalizedStatus.provider,
      actualInstanceId,
    });
    return undefined;
  });

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProviderStatus;
}) => {
  const tempPath = `${input.filePath}.${process.pid}.${Date.now()}.tmp`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = `${JSON.stringify(input.provider, null, 2)}\n`;

    yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fs.writeFileString(tempPath, encoded);
    yield* fs.rename(tempPath, input.filePath);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }));
      }),
    ),
  );
};
