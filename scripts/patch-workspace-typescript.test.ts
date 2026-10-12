import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_TYPESCRIPT_WORKSPACES,
  patchWorkspaceTypeScript,
} from "./patch-workspace-typescript.ts";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-typescript-prepare-"));
  temporaryRoots.push(root);
  for (const workspace of LEGACY_TYPESCRIPT_WORKSPACES) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), JSON.stringify({ name: workspace }));
  }
  return root;
}

function install(root: string, workspace: string, compilerName: string, fail = false): void {
  const compiler = join(root, "dependencies", compilerName);
  const patcher = join(root, "dependencies", `patcher-${compilerName}`);
  mkdirSync(compiler, { recursive: true });
  mkdirSync(patcher, { recursive: true });
  writeFileSync(join(compiler, "package.json"), JSON.stringify({ name: "typescript" }));
  // A real child process claims a shared write marker. Parallel execution would
  // collide; completed lifetimes also make serial order visible to the parent.
  writeFileSync(
    join(patcher, "cli.js"),
    `const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const workspaceRequire = require('node:module').createRequire(path.join(process.cwd(), 'package.json'));
assert.equal(process.argv[2], 'patch');
assert.equal(process.argv[3], '--dir');
assert.equal(fs.realpathSync(process.argv[4]), fs.realpathSync(${JSON.stringify(compiler)}));
assert.equal(fs.realpathSync(path.dirname(workspaceRequire.resolve('typescript/package.json'))), fs.realpathSync(${JSON.stringify(compiler)}));
const log = path.join(${JSON.stringify(root)}, 'patches.jsonl');
const marker = path.join(${JSON.stringify(root)}, 'active-patcher');
const event = name => fs.appendFileSync(log, JSON.stringify({event: name, compiler: ${JSON.stringify(compilerName)}}) + '\\n');
event('start');
if (${fail}) process.exit(17);
const fd = fs.openSync(marker, 'wx');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.closeSync(fd);
fs.unlinkSync(marker);
event('end');
`,
  );
  const modules = join(root, workspace, "node_modules");
  mkdirSync(join(modules, "@effect"), { recursive: true });
  symlinkSync(compiler, join(modules, "typescript"), "junction");
  symlinkSync(patcher, join(modules, "@effect/language-service"), "junction");
}

function events(root: string): Array<{ event: string; compiler: string }> {
  return readFileSync(join(root, "patches.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("workspace TypeScript preparation", () => {
  it("patches shared compiler links once and distinct compilers in serial", () => {
    const root = fixture();
    install(root, "apps/server", "typescript-a");
    install(root, "apps/web", "typescript-a");
    install(root, "scripts", "typescript-b");
    patchWorkspaceTypeScript(root);
    expect(events(root)).toEqual([
      { event: "start", compiler: "typescript-a" },
      { event: "end", compiler: "typescript-a" },
      { event: "start", compiler: "typescript-b" },
      { event: "end", compiler: "typescript-b" },
    ]);
  });

  it("prepares the installed scripts workspace when other scopes are filtered out", () => {
    const root = fixture();
    install(root, "scripts", "typescript-filtered");
    patchWorkspaceTypeScript(root);
    expect(events(root)).toEqual([
      { event: "start", compiler: "typescript-filtered" },
      { event: "end", compiler: "typescript-filtered" },
    ]);
  });

  it("patches a hoisted root compiler once when workspaces have no local dependency links", () => {
    const root = fixture();
    install(root, ".", "typescript-hoisted");
    patchWorkspaceTypeScript(root);
    expect(events(root)).toEqual([
      { event: "start", compiler: "typescript-hoisted" },
      { event: "end", compiler: "typescript-hoisted" },
    ]);
  });

  it("propagates the failing patcher's exit and does not start later compilers", () => {
    const root = fixture();
    install(root, "apps/server", "typescript-fails", true);
    install(root, "scripts", "typescript-later");
    let failure: unknown;
    try {
      patchWorkspaceTypeScript(root);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 17 });
    expect(events(root)).toEqual([{ event: "start", compiler: "typescript-fails" }]);
  });

  it("does not silently skip an installed compiler with a missing patcher", () => {
    const root = fixture();
    mkdirSync(join(root, "scripts/node_modules/typescript"), { recursive: true });
    writeFileSync(
      join(root, "scripts/node_modules/typescript/package.json"),
      JSON.stringify({ name: "typescript" }),
    );
    expect(() => patchWorkspaceTypeScript(root)).toThrow(
      "Missing Effect language-service patcher for installed scripts",
    );
  });

  it("keeps compiler patching at root postinstall before native TypeScript preparation", () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(metadata.scripts.postinstall).toBe(
      "node scripts/patch-workspace-typescript.ts && effect-tsgo patch --typescript --typescript-package @typescript/native",
    );
    for (const workspace of LEGACY_TYPESCRIPT_WORKSPACES) {
      const manifest = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
      expect(manifest.scripts.prepare ?? "").not.toContain("effect-language-service patch");
    }
  });
});
