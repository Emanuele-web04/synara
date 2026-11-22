import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cachedCompilerEvents,
  compilerEventCacheDirectory,
  compilerToolchainFingerprint,
} from "./compilerEventCache";
import { compileReactSource, type CompilerEvent } from "./reactCompiler";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "synara-compiler-events-"));
  roots.push(root);
  return root;
}

const filePath = "/repo/apps/web/src/components/Fixture.tsx";
const passing: CompilerEvent[] = [{ kind: "CompileSuccess", fnName: "Fixture" }];
const failing: CompilerEvent[] = [
  { kind: "PipelineError", data: "stack overflow" },
  { kind: "CompileError", fnName: "Fixture", detail: { reason: "Unsupported pattern" } },
  { kind: "CompileSuccess", fnName: "helper" },
];

function cache(directory: string | undefined, toolchain = "toolchain-a") {
  const compiled: string[] = [];
  const run = (source: string, events: readonly CompilerEvent[] = passing, file = filePath) =>
    cachedCompilerEvents({
      filePath: file,
      source,
      directory,
      toolchain,
      compile: () => {
        compiled.push(source);
        return events;
      },
    });
  return { compiled, run };
}
const entries = (directory: string) => fs.readdirSync(directory).filter((n) => n.endsWith(".json"));

describe("cachedCompilerEvents", () => {
  it("replays an unchanged module and compiles an edited one", () => {
    const directory = scratch();
    const first = cache(directory);
    expect(first.run("export const a = 1")).toEqual(passing);
    const second = cache(directory);
    expect(second.run("export const a = 1")).toEqual(passing);
    expect(second.compiled).toEqual([]);

    // One changed byte must reach the compiler; the old entry cannot answer for it.
    expect(second.run("export const a = 2", failing)).toEqual(failing);
    expect(second.compiled).toEqual(["export const a = 2"]);
    expect(entries(directory)).toHaveLength(2);
  });

  it("compiles again for another path or toolchain", () => {
    const directory = scratch();
    cache(directory).run("export const a = 1");
    const otherPath = cache(directory);
    otherPath.run("export const a = 1", passing, "/repo/apps/web/src/components/Other.tsx");
    expect(otherPath.compiled).toHaveLength(1);
    const otherToolchain = cache(directory, "toolchain-b");
    otherToolchain.run("export const a = 1");
    expect(otherToolchain.compiled).toHaveLength(1);
  });

  it("replays a failing verdict as failing", () => {
    const directory = scratch();
    cache(directory).run("export const a = 1", failing);
    const replay = cache(directory);
    // The cache stores compile results, not verdicts: a replay fails the guard
    // exactly as the compile it recorded did.
    expect(replay.run("export const a = 1", passing)).toEqual(failing);
    expect(replay.compiled).toEqual([]);
  });

  it("recompiles malformed, partial, foreign and relabelled entries", () => {
    const directory = scratch();
    cache(directory).run("export const a = 1", failing);
    const [name] = entries(directory);
    const entryPath = path.join(directory, name!);
    const valid = fs.readFileSync(entryPath, "utf8");
    cache(directory).run("export const b = 1", passing);
    const otherEntry = entries(directory).find((entry) => entry !== name)!;
    const stored = JSON.parse(valid) as { events: unknown[] };
    const corruptions = [
      valid.slice(0, valid.length / 2),
      "",
      "null",
      JSON.stringify({ ...stored, format: "another-format" }),
      // A valid entry for other bytes copied under this key's name.
      fs.readFileSync(path.join(directory, otherEntry), "utf8"),
      JSON.stringify({ ...stored, events: "[]" }),
      JSON.stringify({ ...stored, events: [{ kind: 1 }] }),
      JSON.stringify({ ...stored, events: [{ kind: "CompileError", detail: { reason: 7 } }] }),
      JSON.stringify({ ...stored, events: [{ kind: "PipelineError", data: { stack: [] } }] }),
    ];
    for (const corruption of corruptions) {
      fs.writeFileSync(entryPath, corruption);
      const replay = cache(directory);
      expect(replay.run("export const a = 1", failing)).toEqual(failing);
      expect(replay.compiled).toEqual(["export const a = 1"]);
      expect(fs.readFileSync(entryPath, "utf8")).toBe(valid);
    }
  });

  it("compiles every time without a cache directory", () => {
    const off = cache(undefined);
    off.run("export const a = 1");
    off.run("export const a = 1");
    expect(off.compiled).toHaveLength(2);
    expect(compilerEventCacheDirectory({})).toBeUndefined();
    expect(compilerEventCacheDirectory({ SYNARA_WEB_TRANSFORM_CACHE_DIR: " " })).toBeUndefined();
    expect(compilerEventCacheDirectory({ SYNARA_WEB_TRANSFORM_CACHE_DIR: "/cache" })).toBe(
      path.join("/cache", "hot-path-compiler"),
    );
  });

  it("replays real compiler events exactly as a fresh compile reports them", () => {
    const directory = scratch();
    const source = [
      'import { useState } from "react";',
      "export function Conditional(props: { x: boolean }) {",
      "  if (props.x) useState(0);",
      "  return <div />;",
      "}",
      "export function Plain(props: { x: number }) {",
      "  return <div>{props.x}</div>;",
      "}",
    ].join("\n");
    const file = path.join(directory, "Fixture.tsx");
    let compiles = 0;
    const run = () =>
      cachedCompilerEvents({
        filePath: file,
        source,
        directory,
        toolchain: "toolchain-a",
        compile: () => {
          compiles += 1;
          return compileReactSource(file, source);
        },
      });
    const fresh = run();
    const replayed = run();
    expect(compiles).toBe(1);
    expect(replayed).toEqual(fresh);
    // The compiler's detail is a class whose reason is a getter; it must survive.
    const bailout = replayed.find((event) => event.kind === "CompileError");
    expect(bailout?.detail?.reason).toContain("Hooks");
    expect(replayed).toContainEqual(
      expect.objectContaining({ kind: "CompileSuccess", fnName: "Plain" }),
    );
  });
});

describe("compilerToolchainFingerprint", () => {
  function installed(root: string, version: string, code: string) {
    const files: Record<string, string> = {
      "babel-plugin-react-compiler/package.json": JSON.stringify({
        name: "babel-plugin-react-compiler",
        version,
      }),
      "babel-plugin-react-compiler/dist/index.js": code,
      "@babel/core/package.json": JSON.stringify({ name: "@babel/core", version: "8.0.1" }),
      "@babel/core/lib/index.js": "module.exports = {};",
    };
    for (const [file, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    const entry: Record<string, string> = {
      "babel-plugin-react-compiler": "babel-plugin-react-compiler/dist/index.js",
      "@babel/core": "@babel/core/lib/index.js",
    };
    return (name: string) => path.join(root, entry[name]!);
  }

  it("misses the cache when the compiler plugin's version or code changes", () => {
    const root = scratch();
    const baseline = compilerToolchainFingerprint(installed(root, "1.0.0", "compile()"));
    expect(compilerToolchainFingerprint(installed(root, "1.0.0", "compile()"))).toBe(baseline);
    const upgraded = compilerToolchainFingerprint(installed(root, "1.0.1", "compile()"));
    const patched = compilerToolchainFingerprint(installed(root, "1.0.0", "compile(patched)"));
    expect(new Set([baseline, upgraded, patched]).size).toBe(3);

    const directory = scratch();
    for (const toolchain of [baseline, upgraded, patched]) {
      const run = cache(directory, toolchain);
      run.run("export const a = 1");
      expect(run.compiled).toHaveLength(1);
    }
  });

  it("fingerprints the installed compiler", () => {
    expect(compilerToolchainFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });
});
