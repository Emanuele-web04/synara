// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import {
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
  setCodexConfigOverlayForced,
  shouldDisableDpCodeBrowserPlugin,
} from "./codexHomePaths.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const DPCODE_BROWSER_PLUGIN_CONFIG_HEADER = '[plugins."dpcode-browser@local"]';
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);

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

  symlinkSync(input.sourcePath, input.targetPath, input.type);
}

export function appendCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  if (config.includes(trimmedSection.split("\n")[0] ?? trimmedSection)) {
    // Section header already present (e.g. user configured it manually):
    // don't duplicate the table, which would make the TOML invalid.
    return config;
  }
  const base = config.trimEnd();
  return base.length > 0 ? `${base}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

// Markers delimiting Synara-managed config appended to the shared overlay
// config.toml. The overlay is rebuilt from the source config on every
// buildCodexProcessEnv call (version checks, discovery, text generation), and
// most callers don't know about the agent-gateway MCP section — the markers
// let those rewrites carry the previously appended block forward instead of
// dropping it while a codex app-server session is about to read the file.
export const SYNARA_MANAGED_CODEX_CONFIG_BEGIN = "# >>> synara managed config >>>";
export const SYNARA_MANAGED_CODEX_CONFIG_END = "# <<< synara managed config <<<";

export function extractManagedCodexConfigSection(config: string): string | undefined {
  const begin = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_BEGIN);
  if (begin === -1) {
    return undefined;
  }
  const contentStart = begin + SYNARA_MANAGED_CODEX_CONFIG_BEGIN.length;
  const end = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_END, contentStart);
  if (end === -1) {
    return undefined;
  }
  const content = config.slice(contentStart, end).trim();
  return content.length > 0 ? content : undefined;
}

// Normalize TOML table headers so legal bracket/dot whitespace does not produce
// duplicate managed tables when comparing user config against Synara config.
function normalizeTomlTableHeaderName(line: string): string | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  return match[1]
    .split(".")
    .map((part) => part.trim())
    .join(".");
}

function findTomlTableHeader(config: string, header: string) {
  const target = normalizeTomlTableHeaderName(header);
  if (!target) {
    return undefined;
  }
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) === target) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function findNextTomlTableHeaderIndex(config: string, start: number): number {
  const tail = config.slice(start);
  let offset = 0;
  for (const rawLine of tail.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) !== undefined) {
      return start + offset;
    }
    offset += rawLine.length + 1;
  }
  return config.length;
}

// True when the config declares the given table header as an actual TOML
// header line (not inside a comment or string, which a raw substring search
// would falsely match — e.g. `# [mcp_servers.synara]` in an example block).
export function configHasTomlTableHeader(config: string, header: string): boolean {
  return findTomlTableHeader(config, header) !== undefined;
}

// Split a TOML snippet into its top-level tables (header line + body).
function splitTomlTables(snippet: string): string[] {
  const tables: string[] = [];
  let current: string[] = [];
  for (const line of snippet.split("\n")) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      tables.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    tables.push(current.join("\n").trim());
  }
  return tables.filter((table) => table.length > 0);
}

// Insert an env-var name into the `exclude` array of an existing
// `[shell_environment_policy]` table, or add the key if the table lacks one.
// Only used when the user already defines the table (we cannot append a
// duplicate table header), because the token exclusion is a security control
// that must survive user-customized policies.
export function mergeShellEnvPolicyExclude(config: string, envVarName: string): string {
  if (!envVarName) {
    return config;
  }
  const headerMatch = findTomlTableHeader(config, "[shell_environment_policy]");
  if (!headerMatch) {
    return config;
  }
  const tableStart = headerMatch.end;
  const tableEnd = findNextTomlTableHeaderIndex(config, tableStart);
  const tableBody = config.slice(tableStart, tableEnd);
  const quotedVar = JSON.stringify(envVarName);

  if (tableBody.includes(quotedVar) || tableBody.includes(`'${envVarName}'`)) {
    return config;
  }

  const excludePattern = /(^\s*exclude\s*=\s*\[)/m;
  const excludeMatch = excludePattern.exec(tableBody);
  if (excludeMatch) {
    const insertAt = tableStart + excludeMatch.index + excludeMatch[0].length;
    return `${config.slice(0, insertAt)}${quotedVar}, ${config.slice(insertAt)}`;
  }

  return `${config.slice(0, tableStart)}\nexclude = [${quotedVar}]${config.slice(tableStart)}`;
}

function appendManagedCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  // Respect user-managed copies table by table: appending a table whose
  // header already exists in the config would produce invalid TOML, and the
  // user's own definition should govern in that case. (The token exclusion is
  // separately merged into user-owned policy tables by the overlay writer.)
  const tables = splitTomlTables(trimmedSection).filter((table) => {
    const header = table.split("\n")[0]?.trim();
    return header === undefined || !configHasTomlTableHeader(config, header);
  });
  if (tables.length === 0) {
    return config;
  }
  return appendCodexConfigSection(
    config,
    `${SYNARA_MANAGED_CODEX_CONFIG_BEGIN}\n${tables.join("\n\n")}\n${SYNARA_MANAGED_CODEX_CONFIG_END}`,
  );
}

function prepareDpCodeCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly disableBrowserPlugin: boolean;
  readonly appendConfigToml?: string;
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
  let overlayConfig = input.disableBrowserPlugin
    ? disableDpCodeBrowserPluginInCodexConfig(sourceConfig)
    : sourceConfig;
  // Callers that don't pass appendConfigToml (version checks, discovery, text
  // generation) must not strip a managed section a concurrent provider
  // session relies on; carry the previously written block forward.
  const overlayConfigPath = path.join(overlayHomePath, "config.toml");
  const managedSection =
    input.appendConfigToml ??
    (existsSync(overlayConfigPath)
      ? extractManagedCodexConfigSection(readFileSync(overlayConfigPath, "utf8"))
      : undefined);
  if (managedSection) {
    overlayConfig = appendManagedCodexConfigSection(overlayConfig, managedSection);
    // Security control that must survive every rewrite: when the user defines
    // their own [shell_environment_policy] (so the managed policy table was
    // skipped), the token exclusion is merged into that table — including on
    // rebuilds from the source config, which otherwise reset the user table
    // to its unmerged form while keeping the MCP block alive.
    const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(managedSection)?.[1];
    if (tokenEnvVar) {
      overlayConfig = mergeShellEnvPolicyExclude(overlayConfig, tokenEnvVar);
    }
  }
  writeFileSync(overlayConfigPath, overlayConfig, "utf8");

  return overlayHomePath;
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    /**
     * Extra config.toml content (e.g. the Synara agent-gateway MCP server)
     * written into the overlay home. Never mutates the user's real config:
     * providing it forces the overlay even when the browser-plugin disable is
     * opted out.
     */
    readonly appendConfigToml?: string;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const disableBrowserPlugin = shouldDisableDpCodeBrowserPlugin(baseEnv);
  if (input.appendConfigToml && !disableBrowserPlugin) {
    // The overlay is being forced despite the browser-plugin opt-out; record
    // it so codexHomePaths write-path predictions (generated images) keep
    // pointing at the home the child process actually writes under.
    setCodexConfigOverlayForced(true);
  }
  const overlayHomePath =
    disableBrowserPlugin || input.appendConfigToml
      ? prepareDpCodeCodexHomeOverlay({
          env: baseEnv,
          disableBrowserPlugin,
          ...(input.homePath ? { homePath: input.homePath } : {}),
          ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
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
