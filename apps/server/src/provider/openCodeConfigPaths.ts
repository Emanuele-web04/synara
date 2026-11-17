// FILE: openCodeConfigPaths.ts
// Purpose: Fingerprint OpenCode's local configuration for model discovery.
// Layer: Server provider runtime utility
// Exports: resolveOpenCodeCompatibleConfigPaths, openCodeCompatibleConfigFingerprint
//
// The CLI merges configuration from the account, overrides and project.
// File metadata lets discovery notice edits without reading config contents.

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import nodePath from "node:path";

export interface OpenCodeConfigPathInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly dataDirectoryName: string;
}

const CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

// Preserve parent segments until the OS resolves any preceding symlink.
const relativeTo = (directory: string, file: string) =>
  nodePath.isAbsolute(file)
    ? file
    : `${directory}${directory.endsWith(nodePath.sep) ? "" : nodePath.sep}${file}`;

/**
 * Enumerate config files using the same account environment and working directory as the CLI.
 */
export function resolveOpenCodeCompatibleConfigPaths(input: OpenCodeConfigPathInput): string[] {
  const env = input.env ?? {};
  const paths = new Set<string>();
  const pushConfigFiles = (directory: string) => {
    for (const fileName of CONFIG_FILE_NAMES) {
      paths.add(relativeTo(directory, fileName));
    }
  };

  const cwd = input.cwd ?? process.cwd();
  const isOpenCode = input.dataDirectoryName === "opencode";
  const configFileOverride = isOpenCode ? env.OPENCODE_CONFIG?.trim() : undefined;
  if (configFileOverride) paths.add(relativeTo(cwd, configFileOverride));

  const configDirOverride = isOpenCode ? env.OPENCODE_CONFIG_DIR?.trim() : undefined;
  if (configDirOverride) pushConfigFiles(relativeTo(cwd, configDirOverride));

  // An isolated account must never fingerprint the ambient user's config.
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || input.homeDir;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const globalDir = relativeTo(
    xdg ? relativeTo(cwd, xdg) : nodePath.join(home, ".config"),
    input.dataDirectoryName,
  );
  pushConfigFiles(globalDir);
  if (isOpenCode) {
    paths.add(relativeTo(globalDir, "config.json"));
    pushConfigFiles(nodePath.join(home, ".opencode"));

    if (!["1", "true"].includes(env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "")) {
      for (let directory = nodePath.resolve(cwd); ; directory = nodePath.dirname(directory)) {
        pushConfigFiles(directory);
        pushConfigFiles(nodePath.join(directory, ".opencode"));
        if (nodePath.dirname(directory) === directory) break;
      }
    }
  }

  return [...paths];
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
  const cwd = input.cwd ?? process.cwd();
  const effectiveCwd = await realpath(cwd).catch(() => cwd);
  const stamps = await Promise.all(
    resolveOpenCodeCompatibleConfigPaths({ ...input, cwd: effectiveCwd }).map(async (filePath) => {
      const stats = await stat(filePath).catch(() => undefined);
      return stats?.isFile() ? [filePath, stats.size, stats.mtimeMs, stats.ctimeMs] : null;
    }),
  );
  const files = stamps.filter((stamp) => stamp !== null);
  return files.length > 0 ? createHash("sha256").update(JSON.stringify(files)).digest("hex") : null;
}
