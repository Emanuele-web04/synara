// FILE: providerStatusCache.test.ts
// Purpose: Verifies cache helpers for provider readiness snapshots.
// Exports: Vitest coverage for tolerant cache reads and atomic cache writes.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache";

const readyCodexStatus = {
  provider: "codex" as const,
  status: "ready" as const,
  available: true,
  authStatus: "authenticated" as const,
  checkedAt: "2026-04-15T10:00:00.000Z",
};

describe("providerStatusCache", () => {
  it("writes and reads provider status snapshots", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-provider-status-cache-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: tempDir,
          provider: readyCodexStatus.provider,
        });

        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: readyCodexStatus,
        });

        return yield* readProviderStatusCache(cachePath);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result).toEqual(readyCodexStatus);
  });

  it("ignores malformed cache files", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-provider-status-cache-bad-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: tempDir,
          provider: readyCodexStatus.provider,
        });

        yield* fileSystem.makeDirectory(path.dirname(cachePath), { recursive: true });
        yield* fileSystem.writeFileString(cachePath, "{ definitely-not-json");

        return yield* readProviderStatusCache(cachePath);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result).toBeUndefined();
  });

  it("keeps provider ordering stable for transport consumers", () => {
    expect(
      orderProviderStatuses([
        {
          provider: "gemini",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-15T10:02:00.000Z",
        },
        {
          provider: "claudeAgent",
          status: "warning",
          available: true,
          authStatus: "unknown",
          checkedAt: "2026-04-15T10:01:00.000Z",
        },
        {
          provider: "cursor",
          status: "ready",
          available: true,
          authStatus: "unknown",
          checkedAt: "2026-04-15T10:03:00.000Z",
        },
        readyCodexStatus,
      ]),
    ).toEqual([
      readyCodexStatus,
      {
        provider: "claudeAgent",
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt: "2026-04-15T10:01:00.000Z",
      },
      {
        provider: "cursor",
        status: "ready",
        available: true,
        authStatus: "unknown",
        checkedAt: "2026-04-15T10:03:00.000Z",
      },
      {
        provider: "gemini",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-04-15T10:02:00.000Z",
      },
    ]);
  });
});
