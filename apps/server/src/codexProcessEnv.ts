// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import * as fs from "node:fs/promises";
import path from "node:path";

import { readActiveCodexProviderEnvKey } from "@synara/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@synara/shared/shell";

import { resolveBaseCodexHomePath, resolveSynaraCodexHomeOverlayPath } from "./codexHomePaths.ts";
import { buildProviderChildEnvironment } from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS = "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS";
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const CODEX_SQLITE_STATE_ENTRY_PATTERN = /^.+\.sqlite(?:-(?:wal|shm|journal))?$/;
const SYNARA_CONFIG_SUPPRESSIONS_FILE = "synara-config-suppressions-v1.json";
const MAX_CONFIG_SUPPRESSION_SECTIONS = 32;
const MAX_CONFIG_SUPPRESSION_HEADER_LENGTH = 256;
const codexOverlayPreparationQueues = new Map<string, Promise<void>>();
// Retired local browser integrations used a stable six-character namespace.
// Match the structural conflict without retaining any previous product name.
const CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN =
  /^\[plugins\."[a-z0-9][a-z0-9-]{5}-browser@local"\]$/;

interface CodexOverlayEntryLinker {
  readonly symlink: typeof fs.symlink;
  readonly copyFile: typeof fs.copyFile;
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

export async function readSynaraConfigSuppressions(markerPath: string): Promise<readonly string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
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

async function writeSynaraConfigSuppressions(
  markerPath: string,
  sectionHeaders: readonly string[],
): Promise<void> {
  const normalized = [...new Set(sectionHeaders.filter(isSafePluginSectionHeader))].slice(
    0,
    MAX_CONFIG_SUPPRESSION_SECTIONS,
  );
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, sectionHeaders: normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, markerPath);
}

export async function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: fs.symlink,
    copyFile: fs.copyFile,
  },
): Promise<void> {
  try {
    await linker.symlink(input.sourcePath, input.targetPath, input.type);
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      await linker.copyFile(input.sourcePath, input.targetPath);
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

async function removeLegacyCodexOverlaySqliteLink(targetPath: string): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await fs.lstat(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (targetStat.isSymbolicLink()) {
    await fs.rm(targetPath, { force: true });
  }
}

async function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
}): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    targetStat = await fs.lstat(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && (await fs.readlink(input.targetPath)) === input.sourcePath) {
      return;
    }

    if (targetStat.isSymbolicLink() || CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      // Auth must mirror the user's real Codex home so external `codex login`
      // changes are visible.
      await fs.rm(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  await linkOrCopyCodexOverlayEntry(input);
}

async function serializeCodexOverlayPreparation<A>(
  overlayHomePath: string,
  prepare: () => Promise<A>,
): Promise<A> {
  const previous = codexOverlayPreparationQueues.get(overlayHomePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(prepare);
  const queued = current.then(
    () => undefined,
    () => undefined,
  );
  codexOverlayPreparationQueues.set(overlayHomePath, queued);
  try {
    return await current;
  } finally {
    if (codexOverlayPreparationQueues.get(overlayHomePath) === queued) {
      codexOverlayPreparationQueues.delete(overlayHomePath);
    }
  }
}

async function prepareSynaraCodexHomeOverlayUnlocked(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  await fs.mkdir(overlayHomePath, { recursive: true });

  for (const entry of await fs.readdir(overlayHomePath)) {
    if (CODEX_SQLITE_STATE_ENTRY_PATTERN.test(entry)) {
      await removeLegacyCodexOverlaySqliteLink(path.join(overlayHomePath, entry));
    }
  }

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(await fs.readdir(sourceHomePath))) {
      if (entry === "config.toml") {
        continue;
      }
      if (CODEX_SQLITE_STATE_ENTRY_PATTERN.test(entry)) {
        // SQLite is mutable app-server state owned by this isolated overlay.
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      const stat = await fs.lstat(sourcePath);
      await ensureCodexOverlaySymlink({
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
  const sourceConfig = await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw cause;
  });
  const suppressionMarkerPath = path.join(overlayHomePath, SYNARA_CONFIG_SUPPRESSIONS_FILE);
  const suppressedSections = [
    ...new Set([
      ...findConflictingLocalBrowserPluginSections(sourceConfig),
      ...(await readSynaraConfigSuppressions(suppressionMarkerPath)),
    ]),
  ].slice(0, MAX_CONFIG_SUPPRESSION_SECTIONS);
  await fs.writeFile(
    path.join(overlayHomePath, "config.toml"),
    disableCodexConfigSections(sourceConfig, suppressedSections, true),
    "utf8",
  );
  await writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);

  return overlayHomePath;
}

async function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }
  return serializeCodexOverlayPreparation(overlayHomePath, () =>
    prepareSynaraCodexHomeOverlayUnlocked(input),
  );
}

export async function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = await prepareSynaraCodexHomeOverlay({
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
  });
  const configuredCodexHome =
    overlayHomePath ?? input.homePath?.trim() ?? baseEnv.CODEX_HOME?.trim();
  const configuredEnv = configuredCodexHome
    ? {
        ...baseEnv,
        CODEX_HOME: configuredCodexHome,
        CODEX_SQLITE_HOME: configuredCodexHome,
      }
    : baseEnv;
  const platform = input.platform ?? process.platform;
  const browserUsePipePath =
    platform === "win32"
      ? undefined
      : resolveCodexBrowserUsePipePath({ env: configuredEnv, platform });
  const effectiveEnv = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: configuredEnv,
  });

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

  if (browserUsePipePath) {
    effectiveEnv[NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS] = browserUsePipePath;
  }

  return effectiveEnv;
}
