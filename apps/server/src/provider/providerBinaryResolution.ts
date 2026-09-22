// FILE: providerBinaryResolution.ts
// Purpose: Resolves provider CLI binaries from PATH and vendor-owned install folders.
// Layer: Server provider runtime

import { existsSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";

import {
  envPathKeyFor,
  executableCandidates,
  executableNameCandidates,
  isExecutableFile,
} from "@synara/shared/executable";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export interface ProviderBinaryResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (path: string) => boolean;
  readonly isExecutable?: (path: string) => boolean;
}

interface ResolvedProviderBinaryResolutionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pathExists: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
}

function resolveOptions(
  options: ProviderBinaryResolutionOptions,
): ResolvedProviderBinaryResolutionOptions {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    pathExists: options.pathExists ?? existsSync,
    isExecutable:
      options.isExecutable ??
      ((path) => isExecutableFile(path, { env: options.env, platform: options.platform })),
  };
}

export function commandExistsOnPath(
  command: string,
  options: ProviderBinaryResolutionOptions = {},
): boolean {
  const resolved = resolveOptions(options);
  for (const candidate of executableCandidates(command, resolved)) {
    if (resolved.pathExists(candidate.path)) return true;
  }
  return false;
}

export function resolveWindowsLocalAppDataBinary(
  relativeCandidates: ReadonlyArray<ReadonlyArray<string>>,
  options: ProviderBinaryResolutionOptions = {},
): string | undefined {
  const resolved = resolveOptions(options);
  if (resolved.platform !== "win32") return undefined;

  const localAppData =
    resolved.env.LOCALAPPDATA?.trim() ||
    (resolved.env.USERPROFILE?.trim()
      ? win32.join(resolved.env.USERPROFILE.trim(), "AppData", "Local")
      : undefined);
  if (!localAppData) return undefined;

  for (const relativePath of relativeCandidates) {
    const candidate = win32.join(localAppData, ...relativePath);
    if (resolved.pathExists(candidate)) return candidate;
  }
  return undefined;
}

function posixPackageManagerBinaryDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = env.HOME?.trim();
  const directories: string[] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/local/bin",
  ];
  if (home) {
    directories.push(
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
      join(home, "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".volta", "bin"),
      join(home, ".asdf", "shims"),
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".proto", "shims"),
      join(home, ".deno", "bin"),
      // pnpm's default global bin differs per OS; nonexistence filters out.
      join(home, ".local", "share", "pnpm"),
      join(home, "Library", "pnpm"),
      join(home, ".yarn", "bin"),
    );
    try {
      for (const versionDir of readdirSync(join(home, ".nvm", "versions", "node"), {
        withFileTypes: true,
      })) {
        if (versionDir.isDirectory()) {
          directories.push(join(home, ".nvm", "versions", "node", versionDir.name, "bin"));
        }
      }
    } catch {
      // nvm not installed; nothing to add.
    }
    for (const fnmRoot of [
      join(home, "Library", "Application Support", "fnm", "node-versions"),
      join(home, ".local", "share", "fnm", "node-versions"),
    ]) {
      try {
        for (const versionDir of readdirSync(fnmRoot, { withFileTypes: true })) {
          if (versionDir.isDirectory()) {
            directories.push(join(fnmRoot, versionDir.name, "installation", "bin"));
          }
        }
      } catch {
        // fnm not installed; nothing to add.
      }
    }
  }
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) directories.push(pnpmHome);
  const npmPrefix = env.npm_config_prefix?.trim();
  if (npmPrefix) directories.push(join(npmPrefix, "bin"));
  return directories;
}

function windowsPackageManagerBinaryDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const userProfile = env.USERPROFILE?.trim();
  const localAppData =
    env.LOCALAPPDATA?.trim() ||
    (userProfile ? win32.join(userProfile, "AppData", "Local") : undefined);
  const roamingAppData =
    env.APPDATA?.trim() ||
    (userProfile ? win32.join(userProfile, "AppData", "Roaming") : undefined);
  const directories: string[] = [];
  if (userProfile) {
    directories.push(
      win32.join(userProfile, ".bun", "bin"),
      win32.join(userProfile, "scoop", "shims"),
      win32.join(userProfile, ".local", "bin"),
      win32.join(userProfile, ".volta", "bin"),
    );
  }
  if (localAppData) {
    directories.push(
      win32.join(localAppData, "pnpm"),
      win32.join(localAppData, "mise", "shims"),
      win32.join(localAppData, "Yarn", "bin"),
    );
  }
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) directories.push(pnpmHome);
  if (roamingAppData) {
    directories.push(win32.join(roamingAppData, "npm"));
  }
  const chocolateyInstall = env.ChocolateyInstall?.trim();
  if (chocolateyInstall) {
    directories.push(win32.join(chocolateyInstall, "bin"));
  } else {
    directories.push(win32.join("C:\\", "ProgramData", "chocolatey", "bin"));
  }
  return directories;
}

// Enumerating version-manager roots hits the filesystem on every call; the
// directory list only changes with the environment, so memoize on the inputs.
const binarySearchDirectoriesCache = new Map<string, ReadonlyArray<string>>();

/**
 * Directories the `opencode` CLI can be installed into: the installer's own
 * `~/.opencode/bin`-style location first, then every package-manager global
 * bin dir. GUI-launched processes often inherit a minimal PATH that misses
 * all of them even though the CLI is installed.
 */
export function openCodeBinarySearchDirectories(
  options: ProviderBinaryResolutionOptions = {},
): ReadonlyArray<string> {
  const resolved = resolveOptions(options);
  const env = resolved.env;
  const key = [
    resolved.platform,
    env.HOME,
    env.USERPROFILE,
    env.LOCALAPPDATA,
    env.APPDATA,
    env.PNPM_HOME,
    env.npm_config_prefix,
    env.ChocolateyInstall,
  ].join("\0");
  const cached = binarySearchDirectoriesCache.get(key);
  if (cached !== undefined) return cached;
  const installerDirs: string[] = [];
  if (resolved.platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    const localAppData =
      env.LOCALAPPDATA?.trim() ||
      (userProfile ? win32.join(userProfile, "AppData", "Local") : undefined);
    if (userProfile) installerDirs.push(win32.join(userProfile, ".opencode", "bin"));
    if (localAppData) installerDirs.push(win32.join(localAppData, "Programs", "opencode"));
    installerDirs.push(...windowsPackageManagerBinaryDirectories(env));
  } else {
    const home = env.HOME?.trim();
    if (home) installerDirs.push(join(home, ".opencode", "bin"));
    installerDirs.push(...posixPackageManagerBinaryDirectories(env));
  }
  binarySearchDirectoriesCache.set(key, installerDirs);
  return installerDirs;
}

export function buildOpenCodeServerProcessEnv(input: {
  readonly experimentalWebSockets?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = buildProviderChildEnvironment({
    provider: "opencode",
    baseEnv: input.baseEnv ?? process.env,
    overrides: input.experimentalWebSockets ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true" } : {},
  });
  // Keep PATH lean: only dirs that actually contain the CLI binary qualify as
  // fallbacks, so unrelated package-manager bins never shadow tools.
  const searchDirectories = directoriesContainingCommand(
    "opencode",
    openCodeBinarySearchDirectories({ env }),
    { env },
  );
  return appendDirectoriesToPathEnv(env, searchDirectories, { env });
}

/**
 * Filters `directories` down to those containing a `command` executable, using
 * the platform's executable name candidates (`.exe`/`.cmd` on Windows).
 */
export function directoriesContainingCommand(
  command: string,
  directories: ReadonlyArray<string>,
  options: ProviderBinaryResolutionOptions = {},
): string[] {
  const resolved = resolveOptions(options);
  const joinPath = resolved.platform === "win32" ? win32.join : join;
  return directories.filter((directory) =>
    executableNameCandidates(command, resolved.platform, resolved.env).some((name) =>
      resolved.isExecutable(joinPath(directory, name)),
    ),
  );
}

/**
 * Returns `env` with each existing directory appended to PATH (deduplicated,
 * preserving the user's own PATH precedence order). Nonexistent entries are
 * dropped so PATH stays clean.
 */
export function appendDirectoriesToPathEnv(
  env: NodeJS.ProcessEnv,
  directories: ReadonlyArray<string>,
  options: ProviderBinaryResolutionOptions = {},
): NodeJS.ProcessEnv {
  const resolved = resolveOptions({ ...options, env });
  const platform = resolved.platform;
  const separator = platform === "win32" ? ";" : ":";
  const pathKey = envPathKeyFor(resolved.env, platform);
  const existing = (resolved.env[pathKey] ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set(
    existing.map((entry) => (platform === "win32" ? entry.toLowerCase() : entry)),
  );
  const appended = directories.filter((directory) => {
    if (directory.trim().length === 0) return false;
    const key = platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key) || !resolved.pathExists(directory)) return false;
    seen.add(key);
    return true;
  });
  if (appended.length === 0) return resolved.env;
  return { ...resolved.env, [pathKey]: [...existing, ...appended].join(separator) };
}
