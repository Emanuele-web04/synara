// FILE: install-git-hooks.ts
// Purpose: Installs a launcher for the tracked pre-push check in a developer clone.
// Layer: Root `prepare` lifecycle (runs on `bun install`, never with --ignore-scripts)
// Depends on: scripts/lib/env-bool.ts and the `git` executable when present.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptionalBooleanEnvValue } from "./lib/env-bool.ts";

const TRACKED_PRE_PUSH = ".githooks/pre-push";
const PRE_PUSH_LAUNCHER = `#!/bin/sh
# Installed by Synara. Git runs pre-push from the current worktree root.
if [ -f ${TRACKED_PRE_PUSH} ]; then
  exec /bin/sh ${TRACKED_PRE_PUSH} "$@"
fi
`;

type GitHooksResult =
  | { readonly action: "installed" | "unchanged" }
  | { readonly action: "skipped"; readonly reason: string };

function runsInCi(value: string | undefined): boolean {
  try {
    return parseOptionalBooleanEnvValue("CI", value, false);
  } catch {
    // Providers that set CI to a name rather than a boolean are still CI.
    return true;
  }
}

function git(root: string, args: readonly string[]) {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return { ok: !result.error && result.status === 0, stdout: result.stdout?.trim() ?? "" };
}

/**
 * Adds only the pre-push hook in Git's default directory. The launcher uses
 * the current worktree's tracked hook, which may be absent on older branches.
 */
export function installGitHooks(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHooksResult {
  if (runsInCi(env.CI)) return { action: "skipped", reason: "CI" };
  if (!existsSync(join(root, TRACKED_PRE_PUSH))) {
    return { action: "skipped", reason: `no ${TRACKED_PRE_PUSH} in this copy` };
  }
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return { action: "skipped", reason: "not a Git checkout" };
  // A staged or vendored copy inside another repository must not rewire it.
  if (relative(realpathSync(topLevel.stdout), realpathSync(root)) !== "") {
    return { action: "skipped", reason: "not the repository root" };
  }
  const current = git(root, ["config", "--get", "core.hooksPath"]);
  if (current.ok) return { action: "skipped", reason: "core.hooksPath is already configured" };
  const hook = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"]);
  if (!hook.ok || !hook.stdout) return { action: "skipped", reason: "no Git hook path" };

  mkdirSync(dirname(hook.stdout), { recursive: true });
  try {
    writeFileSync(hook.stdout, PRE_PUSH_LAUNCHER, { flag: "wx", mode: 0o755 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return { action: "unchanged" };
    }
    throw error;
  }
  return { action: "installed" };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = installGitHooks(root);
    if (result.action === "installed") {
      console.log("Git hooks: installed the pre-push check (runs fmt:check and lint).");
    } else if (result.action === "skipped" && result.reason !== "CI") {
      console.log(`Git hooks: not installed (${result.reason}).`);
    }
  } catch (error) {
    // A hook convenience must never fail dependency installation.
    console.warn(`Git hooks: not installed (${String(error)}).`);
  }
}
