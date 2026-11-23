import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUNDLED_DEPS_GUARD_ENV,
  bundledDepsOptimizer,
  contractsEntries,
  effectEntriesInUse,
  loadsFromSourceBesideBundle,
} from "./unit-test-deps";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const guardActive = process.env[BUNDLED_DEPS_GUARD_ENV] === "1";
const guardMessage = /beside the pre-bundled Effect and @synara\/contracts/;

describe("Web Unit pre-bundle entries", () => {
  it("bundles every export of @synara/contracts", () => {
    expect(contractsEntries()).toEqual([
      "@synara/contracts",
      "@synara/contracts/composerSlashCommands",
      "@synara/contracts/hostUsage",
      "@synara/contracts/productAnalytics",
      "@synara/contracts/reliability",
      "@synara/contracts/uiLocale",
    ]);
  });

  it("bundles the Effect paths the sources import", () => {
    const include = bundledDepsOptimizer().include;
    expect(include).toContain("effect");
    expect(include).toContain("effect/Schema");
    expect(include).toContain("effect/unstable/rpc");
    expect(
      include.every(
        (entry) =>
          entry === "effect" ||
          entry.startsWith("effect/") ||
          entry.startsWith("@synara/contracts"),
      ),
    ).toBe(true);
  });

  it("finds static, dynamic and mocked Effect imports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unit-test-deps-"));
    try {
      // PKG stands in for the package name so this file's own scan ignores the sample.
      const sample = [
        'import { Effect } from "PKG";',
        'export { Schema } from "PKG/Schema";',
        'const lazy = () => import("PKG/Duration");',
        'vi.mock("PKG/Random", () => ({}));',
        'const label = "PKG/not-an-import";',
      ];
      fs.writeFileSync(path.join(dir, "sample.ts"), sample.join("\n").replaceAll("PKG", "effect"));
      expect(effectEntriesInUse([dir])).toEqual([
        "effect",
        "effect/Duration",
        "effect/Random",
        "effect/Schema",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies source paths that would load beside the bundle", () => {
    for (const id of [
      "/repo/packages/contracts/src/uiLocale.ts",
      "/repo/node_modules/.bun/effect@4.0.0/node_modules/effect/dist/Schema.js",
      "/repo/node_modules/@effect/vitest/dist/index.js",
      "C:\\repo\\node_modules\\effect\\dist\\index.js",
    ])
      expect(loadsFromSourceBesideBundle(id), id).toBe(true);
    for (const id of [
      "/repo/apps/web/node_modules/.vite/vitest/abc/deps_ssr/effect.js?v=1",
      "/repo/apps/web/node_modules/.vite/vitest/abc/deps_ssr/@synara_contracts_uiLocale.js",
      "/repo/packages/shared/src/uiLocale.ts",
    ])
      expect(loadsFromSourceBesideBundle(id), id).toBe(false);
  });
});

// Specifiers are passed at runtime so the entry scan does not bundle them.
const load = (specifier: string) => import(/* @vite-ignore */ specifier);

// Runs only under vitest.unit.ci.config.ts, where the bundle and guard exist.
describe.runIf(guardActive)("Web Unit pre-bundle guard", () => {
  it("fails an import of contracts source beside the bundle", async () => {
    for (const module of ["uiLocale", "composerSlashCommands"]) {
      const source = path.join(repoRoot, "packages/contracts/src", `${module}.ts`);
      await expect(load(source), module).rejects.toThrow(guardMessage);
    }
  });

  it("fails an Effect path that is not in the bundle", async () => {
    const include = new Set(bundledDepsOptimizer().include);
    // Effect exports every `dist/<Module>.js` as `effect/<Module>`.
    const missing = fs
      .readdirSync(path.join(repoRoot, "apps/web/node_modules/effect/dist"))
      .filter((file) => /^[A-Z]\w*\.js$/.test(file))
      .map((file) => `effect/${file.slice(0, -3)}`)
      .find((entry) => !include.has(entry));
    expect(missing).toBeDefined();
    await expect(load(missing!)).rejects.toThrow(guardMessage);
  });

  it("serves contracts subpaths and the index from one module instance", async () => {
    const index = await import("@synara/contracts");
    const uiLocale = await import("@synara/contracts/uiLocale");
    expect(uiLocale.UI_LOCALES).toBe(index.UI_LOCALES);
  });
});
