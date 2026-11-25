// Web Unit pre-bundling of Effect and @synara/contracts.
//
// Vitest normally evaluates every Effect and contracts module separately in
// each test file. The CI config pre-bundles them once per run instead. A module
// that is part of the bundle must never also load from source: two copies hold
// separate module state, the way `@synara/contracts/uiLocale` and
// `@synara/contracts/composerSlashCommands` did beside a bundled index. The
// guard plugin fails the importing test file whenever that would happen.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Every directory whose modules Web Unit runs through Vite. Contracts is not
// listed: its source is inside the bundle.
const scannedSourceRoots = [
  "apps/web/src",
  "apps/web/scripts",
  "packages/shared/src",
  "packages/profile-ui/src",
];

/** Set for test files when the guard is active, so its own test can tell. */
export const BUNDLED_DEPS_GUARD_ENV = "SYNARA_BUNDLED_DEPS_GUARD";

// Bare bundled specifiers, and source paths into contracts (relative or absolute).
const guardedSpecifier = /^(?:effect|@effect\/[^/]+|@synara\/contracts)(?:\/|$)|\/contracts\/src\//;
const sourceBesideBundle =
  /\/packages\/contracts\/src\/|\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:effect|@effect\/[^/]+)\//;
const effectSpecifier = /(?:\bfrom|\bimport|\()\s*["'](effect(?:\/[\w./-]+)?)["']/g;
const sourceFile = /\.(?:[cm]?[jt]sx?)$/;

/** `@synara/contracts` plus one entry per subpath in its exports map. */
export function contractsEntries(): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/contracts/package.json"), "utf8"),
  ) as { exports: Record<string, unknown> };
  return Object.keys(manifest.exports)
    .map((key) => (key === "." ? "@synara/contracts" : `@synara/contracts/${key.slice(2)}`))
    .toSorted();
}

/** Every `effect` and `effect/…` specifier imported under the given roots. */
export function effectEntriesInUse(roots: readonly string[] = scannedSourceRoots): string[] {
  const found = new Set<string>(["effect"]);
  for (const root of roots) {
    const dir = path.resolve(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !sourceFile.test(entry.name)) continue;
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
      if (!text.includes("effect")) continue;
      for (const match of text.matchAll(effectSpecifier)) found.add(match[1]!);
    }
  }
  return [...found].toSorted();
}

/** The `deps.optimizer.ssr` options for the Web Unit projects. */
export function bundledDepsOptimizer() {
  return {
    enabled: true,
    // Vite's optimizer hash does not cover linked workspace source, so a
    // reused bundle could serve stale contracts. Rebuild it every run.
    force: true,
    include: [...effectEntriesInUse(), ...contractsEntries()],
  };
}

/** Whether a resolved module id is Effect or contracts source outside the bundle. */
export function loadsFromSourceBesideBundle(resolvedId: string): boolean {
  return sourceBesideBundle.test(resolvedId.replaceAll("\\", "/"));
}

/** Drops the `v` version parameter that Vite appends to pre-bundled entries. */
export function withoutVersionQuery(id: string): string {
  return id.replace(/[?&]v=[\w-]+$/, "").replace(/\?v=[\w-]+&/, "?");
}

/**
 * Fails an import of an Effect, `@effect/*` or `@synara/contracts` module
 * that would resolve to source instead of the pre-bundled copy.
 */
export function bundledDepsGuard(): Plugin {
  return {
    name: "synara:bundled-deps-guard",
    enforce: "pre",
    resolveId: {
      filter: { id: guardedSpecifier },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (!resolved) return null;
        if (loadsFromSourceBesideBundle(resolved.id)) {
          throw new Error(
            `${source} (imported by ${importer ?? "a test"}) resolves to ${resolved.id}, ` +
              "beside the pre-bundled Effect and @synara/contracts. A second copy would hold " +
              "separate module state. Import it through a bundled entry, or make " +
              "apps/web/scripts/unit-test-deps.ts include it.",
          );
        }
        // Bundle files import each other without Vite's `?v=` version query.
        // Keeping it would load an entry that another entry also imports,
        // such as `@synara/contracts/uiLocale`, a second time under that URL.
        return { ...resolved, id: withoutVersionQuery(resolved.id) };
      },
    },
  };
}
