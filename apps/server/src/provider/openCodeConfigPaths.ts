// FILE: openCodeConfigPaths.ts
// Purpose: Candidate config file locations for OpenCode-compatible CLIs, plus a
//          content fingerprint used to invalidate the model discovery cache.
// Layer: Server provider runtime utility
// Exports: resolveOpenCodeCompatibleConfigPaths, openCodeCompatibleConfigFingerprint
//
// OpenCode reads its provider and model declarations from a JSON/JSONC config
// file (`opencode.json` / `opencode.jsonc`) resolved from the XDG config home,
// falling back to `~/.config` on every OS. Synara never reads that file for
// discovery — it shells out to `opencode models`, which reads it itself — so a
// rename inside the file changes nothing in the discovery cache key. This module
// supplies a fingerprint of those files so an edit forces rediscovery.

import { stat } from "node:fs/promises";
import nodePath from "node:path";

export interface OpenCodeConfigPathInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly dataDirectoryName: string;
}

const CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * Returns the candidate config file paths in precedence order. Kept in step
 * with how OpenCode resolves its own config so the fingerprint watches the
 * files the CLI actually reads.
 */
export function resolveOpenCodeCompatibleConfigPaths(input: OpenCodeConfigPathInput): string[] {
  const env = input.env ?? {};
  const paths: string[] = [];
  const pushConfigFiles = (directory: string) => {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = nodePath.join(directory, fileName);
      if (!paths.includes(filePath)) paths.push(filePath);
    }
  };

  // A per-provider config directory override wins over the XDG default.
  const configDirOverride =
    input.dataDirectoryName === "opencode" ? env.OPENCODE_CONFIG_DIR?.trim() : undefined;
  if (configDirOverride) pushConfigFiles(configDirOverride);

  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) pushConfigFiles(nodePath.join(xdg, input.dataDirectoryName));

  // Canonical path on Linux, macOS, and Windows (`xdg-basedir`).
  pushConfigFiles(nodePath.join(input.homeDir, ".config", input.dataDirectoryName));

  if (input.platform === "win32") {
    const appData = env.APPDATA?.trim() || nodePath.join(input.homeDir, "AppData", "Roaming");
    pushConfigFiles(nodePath.join(appData, input.dataDirectoryName));
  }

  return paths;
}

/**
 * A stable fingerprint of the config files that currently exist.
 *
 * Uses size and mtime rather than file contents: discovery shells out to the
 * CLI anyway, so the fingerprint only needs to answer "has this changed?".
 * Files that do not exist contribute nothing, so creating a config file for the
 * first time still changes the fingerprint and triggers a fresh discovery.
 * Returns `null` when no config file exists, matching the other optional parts
 * of a cache key. Unreadable files are skipped rather than failing discovery, so
 * the cache then behaves exactly as it did before this fingerprint existed.
 */
export async function openCodeCompatibleConfigFingerprint(
  input: OpenCodeConfigPathInput,
): Promise<string | null> {
  const parts: string[] = [];
  for (const filePath of resolveOpenCodeCompatibleConfigPaths(input)) {
    const stats = await stat(filePath).catch(() => undefined);
    if (!stats?.isFile()) continue;
    parts.push(`${filePath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
  }
  return parts.length > 0 ? parts.join("|") : null;
}
