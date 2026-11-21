// FILE: compilerEventCache.ts
// Purpose: Memoize the React Compiler events the hot-path guard asserts on, so
//          CI compiles a guarded module only when its bytes or the compiler
//          toolchain changed (.github/CI.md, "Hot-path compiler event cache").
// Layer: Web test helper
// Depends on: compiler-cache-key.ts (the transform cache's toolchain fingerprint).

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compilerCacheFingerprint } from "../../scripts/compiler-cache-key";
import type { CompilerEvent } from "./reactCompiler";

// Bump when the entry layout or the recorded projection changes.
const FORMAT = "synara-hot-path-compiler-events-v1";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = path.resolve(webRoot, "../..");

// The compile options live in reactCompiler.ts and the guard in
// hotPathCompiler.ts; editing either invalidates every entry.
const HARNESS_FILES = [
  "src/test/compilerEventCache.ts",
  "src/test/hotPathCompiler.ts",
  "src/test/reactCompiler.ts",
];
const COMPILER_PACKAGES = ["babel-plugin-react-compiler", "@babel/core"];

/** Directory for entries, or undefined when the cache is off (the default outside CI). */
export function compilerEventCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const root = env.SYNARA_WEB_TRANSFORM_CACHE_DIR?.trim();
  return root ? path.join(root, "hot-path-compiler") : undefined;
}

function packageManifest(entry: string, name: string): { version?: unknown } {
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      const manifest = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === name) return manifest;
    }
    if (path.dirname(directory) === directory) throw new Error(`No package.json for ${name}.`);
  }
}

/**
 * Every input of a compile other than the module itself: the transform cache's
 * fingerprint (Node version, normalized lockfile, patches, compiler plugin and
 * Vite config), this harness, and the installed compiler packages' versions
 * and entry bytes, which also cover a node_modules that drifted from the lockfile.
 */
export function compilerToolchainFingerprint(
  resolvePackage: (name: string) => string = createRequire(path.join(webRoot, "package.json"))
    .resolve,
): string {
  const hash = createHash("sha256")
    .update(FORMAT)
    .update("\0")
    .update(compilerCacheFingerprint(repositoryRoot))
    .update("\0");
  for (const file of HARNESS_FILES) {
    hash
      .update(file)
      .update("\0")
      .update(fs.readFileSync(path.join(webRoot, file)))
      .update("\0");
  }
  for (const name of COMPILER_PACKAGES) {
    const entry = resolvePackage(name);
    hash
      .update(name)
      .update("\0")
      .update(String(packageManifest(entry, name).version))
      .update("\0")
      .update(fs.readFileSync(entry))
      .update("\0");
  }
  // Babel reads these when it resolves options; the guard passes none, but an
  // entry must never answer for a run that could have resolved differently.
  hash.update(JSON.stringify([process.env.BABEL_ENV ?? null, process.env.NODE_ENV ?? null]));
  return hash.digest("hex");
}

let defaultToolchain: string | undefined;

/**
 * Only what the guard reads from an event, read through the same property
 * accesses (the compiler's `detail` is a class with getters, which JSON alone
 * would drop). Fresh and cached results both pass through this projection and
 * a JSON round trip, so a hit can never differ from the compile it replays.
 */
export function recordCompilerEvents(events: readonly CompilerEvent[]): CompilerEvent[] {
  const recorded = events.map((event) => ({
    kind: event.kind,
    fnName: event.fnName,
    detail:
      event.detail === undefined
        ? undefined
        : { reason: event.detail?.reason, description: event.detail?.description },
    // Kept only to explain a PipelineError when the guard fails.
    data:
      event.kind === "PipelineError" && event.data !== undefined ? String(event.data) : undefined,
  }));
  return JSON.parse(JSON.stringify(recorded)) as CompilerEvent[];
}

const optionalString = (value: unknown) =>
  value === undefined || value === null || typeof value === "string";

function isRecordedEvent(value: unknown): value is CompilerEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.kind !== "string" || !optionalString(event.fnName)) return false;
  if (!(event.data === undefined || typeof event.data === "string")) return false;
  if (event.detail === undefined) return true;
  if (typeof event.detail !== "object" || event.detail === null) return false;
  const detail = event.detail as Record<string, unknown>;
  return optionalString(detail.reason) && optionalString(detail.description);
}

function readEntry(entryPath: string, key: string): CompilerEvent[] | undefined {
  try {
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf8")) as Record<string, unknown>;
    // The stored key must match the file name it was read from: a renamed,
    // copied or truncated entry is recompiled, never trusted.
    if (entry.format !== FORMAT || entry.key !== key || !Array.isArray(entry.events)) return;
    if (!entry.events.every(isRecordedEvent)) return;
    return entry.events;
  } catch {
    return undefined;
  }
}

function writeEntry(entryPath: string, key: string, events: CompilerEvent[]): void {
  // Rename is atomic within a directory, so a reader sees no entry or a whole one.
  const temporaryPath = `${entryPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify({ format: FORMAT, key, events }));
    fs.renameSync(temporaryPath, entryPath);
  } catch {
    // The guard still asserts on the fresh compile when the cache cannot be written.
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Returns the recorded events of compiling `source` at `filePath`. An entry is
 * keyed by the toolchain fingerprint, the absolute path and the exact source,
 * so any edit, dependency, patch or harness change compiles for real. Without
 * a directory every call compiles.
 */
export function cachedCompilerEvents(input: {
  readonly filePath: string;
  readonly source: string;
  readonly compile: () => readonly CompilerEvent[];
  readonly directory?: string | undefined;
  readonly toolchain?: string;
}): CompilerEvent[] {
  const directory = "directory" in input ? input.directory : compilerEventCacheDirectory();
  if (!directory) return recordCompilerEvents(input.compile());
  const toolchain = input.toolchain ?? (defaultToolchain ??= compilerToolchainFingerprint());
  const key = createHash("sha256")
    .update(toolchain)
    .update("\0")
    .update(path.resolve(input.filePath))
    .update("\0")
    .update(input.source)
    .digest("hex");
  const entryPath = path.join(directory, `${key}.json`);
  const cached = readEntry(entryPath, key);
  if (cached) return cached;
  const events = recordCompilerEvents(input.compile());
  writeEntry(entryPath, key, events);
  return events;
}
