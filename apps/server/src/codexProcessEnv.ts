// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { readActiveCodexProviderEnvKey } from "@t3tools/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@t3tools/shared/shell";

import {
  resolveBaseCodexHomePath,
  resolveCodexHomeOverlayAccountSegment,
  resolveDpCodeCodexHomeOverlayPath,
  shouldDisableDpCodeBrowserPlugin,
} from "./codexHomePaths.ts";
import { codexPathsReferenceSameLocation } from "./codexPathIdentity.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const DPCODE_BROWSER_PLUGIN_CONFIG_HEADER = '[plugins."dpcode-browser@local"]';
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const CODEX_ACCOUNT_PRIVATE_STATE_FILES = new Set(["auth.json", "models_cache.json"]);

interface CodexOverlayEntryLinker {
  readonly symlink: typeof symlinkSync;
  readonly copyFile: typeof copyFileSync;
}

export function resolveCodexBrowserUsePipePath(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): string {
  const env = input.env ?? process.env;
  const configured =
    env.SYNARA_BROWSER_USE_PIPE_PATH?.trim() ||
    env.DPCODE_BROWSER_USE_PIPE_PATH?.trim() ||
    env.T3CODE_BROWSER_USE_PIPE_PATH?.trim();
  if (configured) {
    return configured;
  }
  return (input.platform ?? process.platform) === "win32"
    ? String.raw`\\.\pipe\codex-browser-use`
    : "/tmp/codex-browser-use.sock";
}

export function disableDpCodeBrowserPluginInCodexConfig(config: string): string {
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetSection = false;
  let sawTargetSection = false;
  let targetSectionHasEnabled = false;

  const closeTargetSection = () => {
    if (inTargetSection && !targetSectionHasEnabled) {
      output.push("enabled = false");
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      closeTargetSection();
      inTargetSection = trimmed === DPCODE_BROWSER_PLUGIN_CONFIG_HEADER;
      sawTargetSection ||= inTargetSection;
      targetSectionHasEnabled = false;
      output.push(line);
      continue;
    }

    if (inTargetSection && /^\s*enabled\s*=/.test(line)) {
      output.push("enabled = false");
      targetSectionHasEnabled = true;
      continue;
    }

    output.push(line);
  }

  closeTargetSection();

  if (!sawTargetSection) {
    if (output.length > 0 && output.at(-1)?.trim()) {
      output.push("");
    }
    output.push(DPCODE_BROWSER_PLUGIN_CONFIG_HEADER, "enabled = false");
  }

  return output.join("\n");
}

export function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: symlinkSync,
    copyFile: copyFileSync,
  },
): void {
  try {
    linker.symlink(input.sourcePath, input.targetPath, input.type);
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      linker.copyFile(input.sourcePath, input.targetPath);
      return;
    }
    throw error;
  }
}

export function prioritizeCodexOverlayEntries(entries: readonly string[]): string[] {
  const sharedStateEntries: string[] = [];
  const otherEntries: string[] = [];

  for (const entry of entries) {
    if (CODEX_OVERLAY_SHARED_STATE_FILES.has(entry)) {
      sharedStateEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  return [...sharedStateEntries, ...otherEntries];
}

function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
  readonly force?: boolean;
}): void {
  let targetStat: ReturnType<typeof lstatSync> | undefined;
  try {
    targetStat = lstatSync(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && readlinkSync(input.targetPath) === input.sourcePath) {
      return;
    }

    if (
      input.force ||
      targetStat.isSymbolicLink() ||
      /^.+\.sqlite(?:-(?:wal|shm|journal))?$/.test(input.entryName) ||
      CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)
    ) {
      // SQLite files must stay generation-matched, and auth must mirror the
      // user's real Codex home so external `codex login` changes are visible.
      rmSync(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  linkOrCopyCodexOverlayEntry(input);
}

// A symlinked shadow home (or one resolving to the source home) aliases
// another account's credentials through the directory itself; both overlay
// and direct plugin-enabled launches must reject that configuration.
function validateCodexShadowHomePath(sourceHomePath: string, shadowHomePath: string): void {
  if (codexPathsReferenceSameLocation(sourceHomePath, shadowHomePath)) {
    throw new Error("Codex account shadow home must be different from CODEX_HOME.");
  }
  let shadowStat: ReturnType<typeof lstatSync> | undefined;
  try {
    shadowStat = lstatSync(shadowHomePath);
  } catch {
    shadowStat = undefined;
  }
  if (shadowStat?.isSymbolicLink()) {
    throw new Error(
      `Codex account shadow home at ${shadowHomePath} is a symlink; it must be a real directory so accounts cannot alias each other's auth.`,
    );
  }
}

// A symlinked auth.json can silently alias another account's credentials, so
// account-private state must always be a real file in the shadow home.
// Returns the entry's lstat, or undefined when it does not exist yet.
function lstatShadowPrivateState(
  shadowHomePath: string,
  entry: string,
): ReturnType<typeof lstatSync> | undefined {
  const sourcePath = path.join(shadowHomePath, entry);
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch {
    // Missing shadow state should not prevent Codex from creating account
    // state lazily, but existing private files must never be read or logged.
    return undefined;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(
      `Codex account private state at ${sourcePath} is a symlink; it must be a real file so accounts cannot alias each other's auth.`,
    );
  }
  return sourceStat;
}

// Materialize the source home's config.toml unmodified so direct
// (plugin-enabled) launches keep the user's plugin/model-provider
// configuration in the home Codex actually runs against.
function materializeSourceCodexConfig(sourceHomePath: string, targetHomePath: string): void {
  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
  writeFileSync(path.join(targetHomePath, "config.toml"), sourceConfig, "utf8");
}

function prepareDpCodeCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly accountId?: string;
}): string | undefined {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  // An explicit path that resolves to the ambient/default Codex home is still
  // shared. Only a genuinely separate account home may mirror private state.
  const defaultHomePath = resolveBaseCodexHomePath(input.env);
  const hasDedicatedAccountHome = Boolean(
    input.homePath?.trim() && !codexPathsReferenceSameLocation(sourceHomePath, defaultHomePath),
  );
  const shadowHomePath = input.shadowHomePath
    ? resolveBaseCodexHomePath(input.env, input.shadowHomePath)
    : undefined;
  if (shadowHomePath) {
    validateCodexShadowHomePath(sourceHomePath, shadowHomePath);
  }
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(shadowHomePath ? { shadowHomePath } : {}),
  });
  const overlayHomePath = resolveDpCodeCodexHomeOverlayPath(
    input.env,
    sourceHomePath,
    accountSegment,
  );
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  mkdirSync(overlayHomePath, { recursive: true });

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(readdirSync(sourceHomePath))) {
      if (entry === "config.toml") {
        continue;
      }
      // Account overlays only inherit account-private state when the source
      // home is the account's own dedicated home. With a shadow home the
      // private files are linked from there below; with a shared source home
      // the account keeps its own login inside the overlay instead of
      // silently reusing the default account's credentials.
      if (
        accountSegment &&
        CODEX_ACCOUNT_PRIVATE_STATE_FILES.has(entry) &&
        (shadowHomePath || !hasDedicatedAccountHome)
      ) {
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      const stat = lstatSync(sourcePath);
      ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath,
        targetPath,
        type: stat.isDirectory() ? "dir" : "file",
      });
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  if (accountSegment && !shadowHomePath && !hasDedicatedAccountHome) {
    dropStaleAccountPrivateStateSymlinks(overlayHomePath);
  }

  if (shadowHomePath) {
    for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
      const sourceStat = lstatShadowPrivateState(shadowHomePath, entry);
      if (!sourceStat) {
        continue;
      }
      const targetPath = path.join(overlayHomePath, entry);
      ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath: path.join(shadowHomePath, entry),
        targetPath,
        type: sourceStat.isDirectory() ? "dir" : "file",
        force: true,
      });
    }
  }

  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
  writeFileSync(
    path.join(overlayHomePath, "config.toml"),
    disableDpCodeBrowserPluginInCodexConfig(sourceConfig),
    "utf8",
  );

  return overlayHomePath;
}

// Earlier builds symlinked shared private state (auth) into account homes;
// drop the stale alias so the account's own login (a real file) takes its
// place instead of silently aliasing the default account's credentials.
function dropStaleAccountPrivateStateSymlinks(accountHomePath: string): void {
  for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
    const targetPath = path.join(accountHomePath, entry);
    try {
      if (lstatSync(targetPath).isSymbolicLink()) {
        rmSync(targetPath, { force: true });
      }
    } catch {
      // Missing private state is created lazily by the account's own login.
    }
  }
}

// With the dpcode-browser plugin enabled Synara skips the managed overlay,
// but an accountId-only instance still must not share the default Codex
// home/auth. Point CODEX_HOME at the same per-account directory overlay mode
// uses, so login state survives toggling the plugin sentinel.
function prepareDirectCodexAccountHome(
  env: NodeJS.ProcessEnv,
  input: { readonly sourceHomePath?: string; readonly accountId?: string | undefined },
): string | undefined {
  const sourceHomePath = input.sourceHomePath ?? resolveBaseCodexHomePath(env);
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  if (!accountSegment) {
    return undefined;
  }
  const accountHomePath = resolveDpCodeCodexHomeOverlayPath(env, sourceHomePath, accountSegment);
  if (path.resolve(sourceHomePath) === path.resolve(accountHomePath)) {
    return undefined;
  }
  mkdirSync(accountHomePath, { recursive: true });
  dropStaleAccountPrivateStateSymlinks(accountHomePath);
  // Overlay mode may have left a config.toml with the dpcode-browser plugin
  // forced off, and a fresh directory has no config at all.
  materializeSourceCodexConfig(sourceHomePath, accountHomePath);
  return accountHomePath;
}

// Direct (plugin-enabled) shadow homes become the child CODEX_HOME outright,
// so they need the same aliasing guards overlay mode applies plus the source
// home's config that the overlay would otherwise materialize.
function prepareDirectCodexShadowHome(
  env: NodeJS.ProcessEnv,
  input: { readonly homePath?: string | undefined; readonly shadowHomePath: string },
): string {
  const sourceHomePath = resolveBaseCodexHomePath(env, input.homePath);
  const shadowHomePath = resolveBaseCodexHomePath(env, input.shadowHomePath);
  validateCodexShadowHomePath(sourceHomePath, shadowHomePath);
  for (const entry of CODEX_ACCOUNT_PRIVATE_STATE_FILES) {
    lstatShadowPrivateState(shadowHomePath, entry);
  }
  mkdirSync(shadowHomePath, { recursive: true });
  materializeSourceCodexConfig(sourceHomePath, shadowHomePath);
  return shadowHomePath;
}

function shouldUseDirectCodexAccountHome(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly sourceHomePath: string;
  readonly explicitHomePath?: string | undefined;
  readonly accountId?: string | undefined;
}): boolean {
  const accountSegment = resolveCodexHomeOverlayAccountSegment({
    homePath: input.sourceHomePath,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  if (!accountSegment) {
    return false;
  }
  if (!input.explicitHomePath?.trim()) {
    return true;
  }
  return codexPathsReferenceSameLocation(input.sourceHomePath, resolveBaseCodexHomePath(input.env));
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly shadowHomePath?: string;
    readonly accountId?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const directSourceHomePath = resolveBaseCodexHomePath(baseEnv, input.homePath);
  const overlayHomePath = shouldDisableDpCodeBrowserPlugin(baseEnv)
    ? prepareDpCodeCodexHomeOverlay({
        env: baseEnv,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
      })
    : undefined;
  // Only prepared when the overlay is skipped: overlay mode already owns the
  // effective home, so direct-mode side effects (validation, config writes)
  // must not run for it.
  const directAccountHomePath =
    overlayHomePath !== undefined
      ? undefined
      : input.shadowHomePath
        ? prepareDirectCodexShadowHome(baseEnv, {
            ...(input.homePath ? { homePath: input.homePath } : {}),
            shadowHomePath: input.shadowHomePath,
          })
        : shouldUseDirectCodexAccountHome({
              env: baseEnv,
              sourceHomePath: directSourceHomePath,
              explicitHomePath: input.homePath,
              accountId: input.accountId,
            })
          ? prepareDirectCodexAccountHome(baseEnv, {
              sourceHomePath: directSourceHomePath,
              accountId: input.accountId,
            })
          : input.homePath
            ? directSourceHomePath
            : undefined;
  const effectiveEnv =
    overlayHomePath || directAccountHomePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? directAccountHomePath }
      : baseEnv;
  const platform = input.platform ?? process.platform;

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  if (platform !== "win32") {
    const browserUsePipePath = resolveCodexBrowserUsePipePath({ env: effectiveEnv, platform });
    const allowedSockets =
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS]
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];
    if (!allowedSockets.includes(browserUsePipePath)) {
      effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS] = [
        ...allowedSockets,
        browserUsePipePath,
      ].join(",");
    }
  }

  return effectiveEnv;
}
