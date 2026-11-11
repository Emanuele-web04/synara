// FILE: install-git-hooks.ts
// Purpose: Points a developer clone's Git hooks at the tracked .githooks directory.
// Layer: Root `prepare` lifecycle (runs on `bun install`, never with --ignore-scripts)
// Depends on: scripts/lib/env-bool.ts and the `git` executable when present.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptionalBooleanEnvValue } from "./lib/env-bool.ts";

export const HOOKS_PATH = ".githooks";

export type GitHooksResult =
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
 * Enables the tracked hooks for a developer checkout. Every other context is a
 * no-op: CI, release and packaging installs, copies without their own `.git`,
 * and clones whose owner already chose a hooks directory. Never throws.
 */
export function installGitHooks(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHooksResult {
  if (runsInCi(env.CI)) return { action: "skipped", reason: "CI" };
  if (!existsSync(join(root, HOOKS_PATH, "pre-push"))) {
    return { action: "skipped", reason: `no ${HOOKS_PATH}/pre-push in this copy` };
  }
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return { action: "skipped", reason: "not a Git checkout" };
  // A staged or vendored copy inside another repository must not rewire it.
  if (relative(realpathSync(topLevel.stdout), realpathSync(root)) !== "") {
    return { action: "skipped", reason: "not the repository root" };
  }
  const current = git(root, ["config", "--get", "core.hooksPath"]);
  if (current.ok && current.stdout === HOOKS_PATH) return { action: "unchanged" };
  if (current.ok && current.stdout !== "") {
    return { action: "skipped", reason: `core.hooksPath is already ${current.stdout}` };
  }
  if (!git(root, ["config", "--local", "core.hooksPath", HOOKS_PATH]).ok) {
    return { action: "skipped", reason: "git config failed" };
  }
  return { action: "installed" };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = installGitHooks(root);
    if (result.action === "installed") {
      console.log(`Git hooks: core.hooksPath=${HOOKS_PATH} (pre-push runs fmt:check and lint).`);
    } else if (result.action === "skipped" && result.reason !== "CI") {
      console.log(`Git hooks: not installed (${result.reason}).`);
    }
  } catch (error) {
    // A hook convenience must never fail dependency installation.
    console.warn(`Git hooks: not installed (${String(error)}).`);
  }
}
