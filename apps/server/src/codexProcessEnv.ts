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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { readActiveCodexProviderEnvKey } from "@synara/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@synara/shared/shell";

import { resolveBaseCodexHomePath, resolveSynaraCodexHomeOverlayPath } from "./codexHomePaths.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const SYNARA_CONFIG_SUPPRESSIONS_FILE = "synara-config-suppressions-v1.json";
const MAX_CONFIG_SUPPRESSION_SECTIONS = 32;
const MAX_CONFIG_SUPPRESSION_HEADER_LENGTH = 256;
// Retired local browser integrations used a stable six-character namespace.
// Match the structural conflict without retaining any previous product name.
const CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN =
  /^\[plugins\."[a-z0-9][a-z0-9-]{5}-browser@local"\]$/;

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
  const configured = env.SYNARA_BROWSER_USE_PIPE_PATH?.trim();
  if (configured) {
    return configured;
  }
  return (input.platform ?? process.platform) === "win32"
    ? String.raw`\\.\pipe\codex-browser-use`
    : "/tmp/codex-browser-use.sock";
}

function isSafePluginSectionHeader(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONFIG_SUPPRESSION_HEADER_LENGTH &&
    /^\[plugins\."[^"\r\n]+"\]$/.test(value)
  );
}

export function readSynaraConfigSuppressions(markerPath: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const marker = parsed as { version?: unknown; sectionHeaders?: unknown };
    if (marker.version !== 1 || !Array.isArray(marker.sectionHeaders)) return [];
    if (marker.sectionHeaders.length > MAX_CONFIG_SUPPRESSION_SECTIONS) return [];
    return [...new Set(marker.sectionHeaders.filter(isSafePluginSectionHeader))];
  } catch {
    return [];
  }
}

function findConflictingLocalBrowserPluginSections(config: string): readonly string[] {
  return [
    ...new Set(
      config
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN.test(line)),
    ),
  ];
}

export function disableCodexConfigSections(
  config: string,
  sectionHeaders: readonly string[],
  appendMissing = false,
): string {
  const targets = new Set(sectionHeaders.filter(isSafePluginSectionHeader));
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetSection = false;
  const seenTargetSections = new Set<string>();
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
      inTargetSection = targets.has(trimmed);
      if (inTargetSection) seenTargetSections.add(trimmed);
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

  if (appendMissing) {
    for (const header of targets) {
      if (seenTargetSections.has(header)) continue;
      if (output.length > 0 && output.at(-1)?.trim()) {
        output.push("");
      }
      output.push(header, "enabled = false");
    }
  }

  return output.join("\n");
}

function writeSynaraConfigSuppressions(
  markerPath: string,
  sectionHeaders: readonly string[],
): void {
  const normalized = [...new Set(sectionHeaders.filter(isSafePluginSectionHeader))].slice(
    0,
    MAX_CONFIG_SUPPRESSION_SECTIONS,
  );
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, sectionHeaders: normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, markerPath);
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

export function appendCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  if (config.includes(trimmedSection.split("\n")[0] ?? trimmedSection)) {
    return config;
  }
  const base = config.trimEnd();
  return base.length > 0 ? `${base}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

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

function normalizeTomlTableHeaderName(line: string): string | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const tableName = match[1];
  if (tableName === undefined) {
    return undefined;
  }
  return tableName
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

export function configHasTomlTableHeader(config: string, header: string): boolean {
  return findTomlTableHeader(config, header) !== undefined;
}

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
  const tables = splitTomlTables(section.trim()).filter((table) => {
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

function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appendConfigToml?: string;
}): string | undefined {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath);
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
  const suppressionMarkerPath = path.join(overlayHomePath, SYNARA_CONFIG_SUPPRESSIONS_FILE);
  const suppressedSections = [
    ...new Set([
      ...findConflictingLocalBrowserPluginSections(sourceConfig),
      ...readSynaraConfigSuppressions(suppressionMarkerPath),
    ]),
  ].slice(0, MAX_CONFIG_SUPPRESSION_SECTIONS);
  const overlayConfigPath = path.join(overlayHomePath, "config.toml");
  let overlayConfig = disableCodexConfigSections(sourceConfig, suppressedSections, true);
  const managedSection =
    input.appendConfigToml ??
    (existsSync(overlayConfigPath)
      ? extractManagedCodexConfigSection(readFileSync(overlayConfigPath, "utf8"))
      : undefined);
  if (managedSection) {
    overlayConfig = appendManagedCodexConfigSection(overlayConfig, managedSection);
    const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(managedSection)?.[1];
    if (tokenEnvVar) {
      overlayConfig = mergeShellEnvPolicyExclude(overlayConfig, tokenEnvVar);
    }
  }
  writeFileSync(overlayConfigPath, overlayConfig, "utf8");
  writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);

  return overlayHomePath;
}

export function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly appendConfigToml?: string;
  } = {},
): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = prepareSynaraCodexHomeOverlay({
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
  });
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
