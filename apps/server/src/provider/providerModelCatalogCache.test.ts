// FILE: providerModelCatalogCache.test.ts
// Purpose: Locks the durable catalog snapshot contract: atomic round trips,
//          path resolution under stateDir, and resilience to missing or
//          malformed files so a corrupt cache can never block server boot.
// Layer: Server provider tests

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderListModelsResult } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, type FileSystem } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readProviderModelCatalogCache,
  resolveProviderModelCatalogCachePath,
  writeProviderModelCatalogCache,
} from "./providerModelCatalogCache.ts";

const CATALOG: ProviderListModelsResult = {
  models: [{ slug: "gpt-5", name: "GPT-5" }],
  source: "opencode-cli",
  cached: false,
};

let stateDir: string;

const filePath = () => resolveProviderModelCatalogCachePath({ stateDir });

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "model-catalog-cache-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("providerModelCatalogCache", () => {
  it("resolves the snapshot under stateDir/provider-models", () => {
    expect(filePath()).toBe(`${stateDir}/provider-models/catalogs.json`);
  });

  it("returns no entries when the file does not exist", async () => {
    expect(await run(readProviderModelCatalogCache(filePath()))).toEqual([]);
  });

  it("round-trips entries through an atomic write", async () => {
    const entries = [
      {
        key: '["opencode","/bin/opencode",null,null,"/repo/a"]',
        result: CATALOG,
        storedAt: 1_700_000_000_000,
      },
    ];
    await run(writeProviderModelCatalogCache({ filePath: filePath(), entries }));

    const readBack = await run(readProviderModelCatalogCache(filePath()));
    expect(readBack).toEqual(entries);
  });

  it("creates missing parent directories on write", async () => {
    expect(existsSync(path.dirname(filePath()))).toBe(false);
    await run(writeProviderModelCatalogCache({ filePath: filePath(), entries: [] }));
    expect(existsSync(filePath())).toBe(true);
  });

  it("ignores a malformed file instead of failing", async () => {
    mkdirSync(path.dirname(filePath()), { recursive: true });
    writeFileSync(filePath(), "{not-json", { encoding: "utf8" });
    expect(await run(readProviderModelCatalogCache(filePath()))).toEqual([]);
  });

  it("ignores entries whose result fails schema decode", async () => {
    mkdirSync(path.dirname(filePath()), { recursive: true });
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        entries: [{ key: "k", result: { models: "not-an-array" }, storedAt: 1 }],
      }),
    );
    expect(await run(readProviderModelCatalogCache(filePath()))).toEqual([]);
  });

  it.each([
    { roles: [{ name: "smol", model: "upstream/model", thinkingLevel: "high" }] },
    { roles: [{ name: null, model: 42, thinkingLevel: "retired-level" }] },
  ])("strips legacy OMP roles while retaining every persisted catalog: %j", async ({ roles }) => {
    const ompCatalog: ProviderListModelsResult = {
      models: [
        {
          slug: "upstream/model",
          name: "Model",
          upstreamProviderId: "upstream",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
        },
      ],
      source: "omp-cli",
      cached: false,
    };
    const entries = [
      { key: "omp-key", result: ompCatalog, storedAt: 1 },
      { key: "other-provider-key", result: CATALOG, storedAt: 2 },
    ];
    mkdirSync(path.dirname(filePath()), { recursive: true });
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 1,
        entries: [{ ...entries[0], result: { ...ompCatalog, roles } }, entries[1]],
      }),
    );

    const decoded = await run(readProviderModelCatalogCache(filePath()));
    expect(decoded).toEqual(entries);
    await run(writeProviderModelCatalogCache({ filePath: filePath(), entries: decoded }));
    expect(JSON.parse(readFileSync(filePath(), "utf8"))).toEqual({ version: 1, entries });
  });

  it("writes the snapshot as private-mode JSON", async () => {
    await run(
      writeProviderModelCatalogCache({
        filePath: filePath(),
        entries: [{ key: "k", result: CATALOG, storedAt: 5 }],
      }),
    );
    const raw = JSON.parse(readFileSync(filePath(), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
  });
});
