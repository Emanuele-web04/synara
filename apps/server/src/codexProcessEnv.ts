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
  resolveDpCodeCodexHomeOverlayPath,
  shouldDisableDpCodeBrowserPlugin,
} from "./codexHomePaths.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const DPCODE_BROWSER_PLUGIN_CONFIG_HEADER = '[plugins."dpcode-browser@local"]';
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);

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

function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
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

function prepareDpCodeCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
}): string | undefined {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveDpCodeCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  mkdirSync(overlayHomePath, { recursive: true });

  try {
    for (const entry of readdirSync(sourceHomePath)) {
      if (entry === "config.toml") {
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

  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = existsSync(sourceConfigPath) ? readFileSync(sourceConfigPath, "utf8") : "";
  writeFileSync(
    path.join(overlayHomePath, "config.toml"),
    disableDpCodeBrowserPluginInCodexConfig(sourceConfig),
    "utf8",
  );

  return overlayHomePath;
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = shouldDisableDpCodeBrowserPlugin(baseEnv)
    ? prepareDpCodeCodexHomeOverlay({
        env: baseEnv,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      })
    : undefined;
  const effectiveEnv =
    overlayHomePath || input.homePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? input.homePath }
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
