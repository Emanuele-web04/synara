// FILE: pre-push-check.ts
// Purpose: The pre-push gate. Formats, lints and type-checks only what the push
//          changes, so it stays fast enough that nobody skips it.
// Layer: .githooks/pre-push, installed by scripts/install-git-hooks.ts.
// Depends on: git, oxfmt, oxlint and tsrs from the root node_modules, and
//             TYPECHECK_PROJECTS from scripts/typecheck.ts.
// CI stays authoritative: it formats, lints and type-checks the whole tree and
// also runs the Effect diagnostics, which are too slow for a hook.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TYPECHECK_PROJECTS } from "./typecheck.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO = /^0+$/;

/** One `<local ref> <local oid> <remote ref> <remote oid>` line per pushed ref. */
export type PushedRef = { readonly localOid: string; readonly remoteOid: string };

export function parsePushedRefs(stdin: string): PushedRef[] {
  return stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([, localOid, , remoteOid]) => ({ localOid: localOid!, remoteOid: remoteOid! }));
}

function git(args: readonly string[], allowMissing = false): string | null {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  if (result.status === 0) return result.stdout;
  if (allowMissing && result.status === 1 && !result.error) return null;
  throw new Error(
    `git ${args[0]} failed: ${result.error?.message ?? (result.stderr.trim() || result.status)}`,
  );
}

/** The commit the remote already has, or where a new branch left the default branch. */
function baseFor(ref: PushedRef): string | null {
  if (
    !ZERO.test(ref.remoteOid) &&
    git(["rev-parse", "--verify", "--quiet", `${ref.remoteOid}^{commit}`], true) !== null
  )
    return ref.remoteOid;
  for (const upstream of ["origin/HEAD", "origin/main", "main"]) {
    const tip = git(["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`], true)?.trim();
    if (!tip) continue;
    const base = git(["merge-base", ref.localOid, tip], true)?.trim();
    if (base) return base;
  }
  return null;
}

/** Paths whose change can affect every project's types. */
const SHARED = [
  /^packages\//,
  /^scripts\/lib\//,
  /^tsconfig\.(?:base|check)\.json$/,
  /^package\.json$/,
  /^bun\.lock$/,
];

const projectDir = (project: string) => (project.endsWith(".json") ? dirname(project) : project);
/** The workspace a project belongs to: its files may include any of the workspace's sources. */
const workspaceOf = (project: string) =>
  project
    .split("/")
    .slice(0, project.startsWith("scripts") ? 1 : 2)
    .join("/");

/** Projects to type-check for a set of changed files. */
export function affectedProjects(files: readonly string[]): string[] {
  if (files.some((file) => SHARED.some((pattern) => pattern.test(file))))
    return [...TYPECHECK_PROJECTS];
  const typed = files.filter((file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file));
  // The script projects import server and desktop sources across workspace boundaries.
  const affectsScripts = typed.some((file) => /^apps\/(?:server|desktop)\//.test(file));
  return TYPECHECK_PROJECTS.filter((project) => {
    const workspace = workspaceOf(project);
    return (
      typed.some((file) => file.startsWith(`${workspace}/`)) ||
      (workspace === "scripts" && affectsScripts)
    );
  });
}

type Result = { readonly label: string; readonly ok: boolean; readonly seconds: number };

function run(label: string, command: string, args: readonly string[]): Promise<Result> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    const finish = (ok: boolean) =>
      resolve({ label, ok, seconds: (performance.now() - started) / 1000 });
    child.on("error", (error) => {
      console.error(`pre-push: ${label}: ${error.message}`);
      finish(false);
    });
    child.on("exit", (code) => finish(code === 0));
  });
}

// Bun installs native executable shims on Windows.
const bin = (name: string) =>
  join(root, "node_modules/.bin", process.platform === "win32" ? `${name}.exe` : name);

/** tsrs keeps incremental build info per project, so a re-check takes ~0.15 s. */
async function typecheck(projects: readonly string[]): Promise<Result> {
  const started = performance.now();
  let ok = true;
  for (const project of projects) {
    const name = project.endsWith(".json")
      ? project
          .split("/")
          .pop()!
          .replace(/\.json$/, "")
      : "tsconfig";
    const buildInfo = join(projectDir(project), "node_modules/.cache", `tsrs-${name}.tsbuildinfo`);
    const result = await run(`tsrs ${project}`, bin("tsrs"), [
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      buildInfo,
      "--pretty",
      "false",
      "-p",
      project,
    ]);
    ok &&= result.ok;
  }
  return {
    label: `typecheck (${projects.length} projects)`,
    ok,
    seconds: (performance.now() - started) / 1000,
  };
}

async function main() {
  const refs = parsePushedRefs(readFileSync(0, "utf8")).filter((ref) => !ZERO.test(ref.localOid));
  if (refs.length === 0) return; // Only deletions.
  for (const tool of ["oxfmt", "oxlint", "tsrs"]) {
    if (!existsSync(bin(tool))) {
      console.error(
        `pre-push: ${tool} is missing; run \`bun install\` (skip once with --no-verify).`,
      );
      process.exit(1);
    }
  }
  const changed = new Set<string>();
  for (const ref of refs) {
    const base = baseFor(ref);
    // Keep old paths for rename/deletion so they still invalidate owning projects.
    const diff = base
      ? git(["diff", "--name-only", "--no-renames", "-z", base, ref.localOid])
      : git(["ls-tree", "-r", "--name-only", "-z", ref.localOid]);
    for (const file of diff?.split("\0") ?? []) if (file) changed.add(file);
  }
  if (changed.size === 0) return;

  const started = performance.now();
  const projects = affectedProjects([...changed]);
  const files = [...changed].filter((file) =>
    statSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
  );
  // A bulk push can exceed the platform's argument limit. Use the normal tree scope then.
  const paths = Buffer.byteLength(files.join("\0")) > 16_000 ? [] : ["--", ...files];
  const results = await Promise.all([
    files.length > 0
      ? run("format", bin("oxfmt"), ["--check", "--no-error-on-unmatched-pattern", ...paths])
      : Promise.resolve(null),
    files.length > 0
      ? run("lint", bin("oxlint"), ["--quiet", "--report-unused-disable-directives", ...paths])
      : Promise.resolve(null),
    projects.length > 0 ? typecheck(projects) : Promise.resolve(null),
  ]);
  const total = (performance.now() - started) / 1000;
  const summary = results
    .filter((result): result is Result => result !== null)
    .map(
      (result) => `${result.label} ${result.ok ? "ok" : "FAILED"} ${result.seconds.toFixed(1)} s`,
    )
    .join(", ");
  if (summary)
    console.error(
      `pre-push: ${changed.size} changed files: ${summary}; ${total.toFixed(1)} s total`,
    );
  if (results.some((result) => result !== null && !result.ok)) {
    console.error(
      "pre-push: fix the issues above (`bun run fmt` formats), or push with --no-verify.",
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`pre-push: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
