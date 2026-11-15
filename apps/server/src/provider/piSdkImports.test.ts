// FILE: piSdkImports.test.ts
// Purpose: Covers resolving the Pi SDK from a user-installed `pi` CLI (npm and bun global layouts).
// Layer: Unit test

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { piNodeModulesRoot, piPackageEntry } from "./piSdkImports.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PKG = resolve(HERE, "../../node_modules/@earendil-works/pi-coding-agent");
const REAL_PI_AI = resolve(HERE, "../../node_modules/@earendil-works/pi-ai");

// The bin must stay inside the fake prefix after realpath(): npm links bin
// shims into the package dir, so a real (non-symlinked) stub package keeps
// ancestor discovery from escaping into this repo's own node_modules.
function makePrefix(style: "npm" | "bun-shim"): { bin: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-prefix-"));
  const binDir = join(base, "bin");
  const modulesRoot =
    style === "bun-shim"
      ? join(base, "install", "global", "node_modules")
      : join(base, "lib", "node_modules");
  const pkgDir = join(modulesRoot, "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), "{}");
  const cli = join(pkgDir, "dist", "bundle", "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n");
  const bin = join(binDir, "pi");
  if (style === "bun-shim") {
    // bun writes a real shim script in <prefix>/bin, not a symlink.
    writeFileSync(bin, `#!/bin/sh\nexec "${cli}" "$@"\n`);
  } else {
    symlinkSync(relative(binDir, cli), bin);
  }
  return { bin, root: modulesRoot };
}

// Entry resolution and imports need the real SDK: symlink its package dirs
// into a fake prefix. The shim bin is a real file so piNodeModulesRoot lands
// here rather than in the repo's node_modules.
function makeRealPrefix(): { bin: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-prefix-"));
  const binDir = join(base, "bin");
  const modulesRoot = join(base, "lib", "node_modules");
  mkdirSync(join(modulesRoot, "@earendil-works"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  symlinkSync(REAL_PKG, join(modulesRoot, "@earendil-works", "pi-coding-agent"), "junction");
  symlinkSync(REAL_PI_AI, join(modulesRoot, "@earendil-works", "pi-ai"), "junction");
  const bin = join(binDir, "pi");
  writeFileSync(bin, "#!/bin/sh\n");
  return { bin, root: modulesRoot };
}

describe("piSdkImports", () => {
  it("finds node_modules beside an npm-style bin symlink", async () => {
    const { bin, root } = makePrefix("npm");
    expect(realpathSync((await piNodeModulesRoot(bin))!)).toBe(realpathSync(root));
  });

  it("finds node_modules for a bun-style shim script in ~/.bun/bin", async () => {
    const { bin, root } = makePrefix("bun-shim");
    expect(realpathSync((await piNodeModulesRoot(bin))!)).toBe(realpathSync(root));
  });

  it("resolves the package root and provider subpaths through the exports map", async () => {
    const { root } = makeRealPrefix();
    // Entries point into the fake prefix's package dirs — compare realpaths.
    expect(realpathSync(await piPackageEntry(root, "@earendil-works/pi-coding-agent"))).toBe(
      realpathSync(join(REAL_PKG, "dist", "index.js")),
    );
    expect(
      realpathSync(await piPackageEntry(root, "@earendil-works/pi-ai/providers/opencode")),
    ).toBe(realpathSync(join(REAL_PI_AI, "dist", "providers", "opencode.js")));
  });

  it("imports the SDK by file URL resolved from the CLI install (packaged fallback)", async () => {
    const { bin, root } = makeRealPrefix();
    // Same path importPiPackage takes after the bare specifier fails in a
    // packaged build: bin → node_modules root → exports entry → file URL.
    expect(realpathSync((await piNodeModulesRoot(bin))!)).toBe(realpathSync(root));
    const entry = await piPackageEntry(root, "@earendil-works/pi-coding-agent");
    const mod = (await import(pathToFileURL(entry).href)) as {
      createAgentSessionRuntime: unknown;
    };
    expect(typeof mod.createAgentSessionRuntime).toBe("function");
  });
});
