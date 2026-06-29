/**
 * CursorAcpCommand - shared command resolution for Cursor's ACP-capable CLI.
 *
 * Keeps the ambiguous legacy `agent` default from colliding with Grok's `agent`
 * executable while still honoring explicit custom Cursor binary paths.
 *
 * @module CursorAcpCommand
 */
import { existsSync } from "node:fs";
import * as path from "node:path";

export const DEFAULT_CURSOR_AGENT_BINARY = "cursor-agent";
export const LEGACY_CURSOR_AGENT_BINARY = "agent";
export const CURSOR_EDITOR_BINARY = "cursor";
export const CURSOR_AGENT_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const satisfies Readonly<Record<string, string>>;
export const CURSOR_AGENT_HEADLESS_PROBE_ENV = {
  ...CURSOR_AGENT_BROWSERLESS_ENV,
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
} as const satisfies Readonly<Record<string, string>>;

export interface CursorAgentCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface CursorAgentCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly pathExists?: (path: string) => boolean;
}

interface ResolvedCursorAgentCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly pathExists: (path: string) => boolean;
}

interface CursorCommandPathParts {
  readonly directory: string;
  readonly extension: string;
  readonly hasDirectory: boolean;
  readonly stem: string;
}

const CURSOR_EXECUTABLE_EXTENSION_PATTERN = /\.(?:bat|cmd|exe|ps1)$/iu;
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;
const WINDOWS_BATCH_EXECUTABLE_EXTENSION = ".cmd";

function splitCursorCommandPath(command: string): CursorCommandPathParts {
  const trimmed = command.trim();
  const forwardSlash = trimmed.lastIndexOf("/");
  const backslash = trimmed.lastIndexOf("\\");
  const separatorIndex = Math.max(forwardSlash, backslash);
  const hasDirectory = separatorIndex >= 0;
  const directory = hasDirectory ? trimmed.slice(0, separatorIndex + 1) : "";
  const filename = hasDirectory ? trimmed.slice(separatorIndex + 1) : trimmed;
  const extension = filename.match(CURSOR_EXECUTABLE_EXTENSION_PATTERN)?.[0] ?? "";
  const stem = (extension ? filename.slice(0, -extension.length) : filename).toLowerCase();
  return { directory, extension, hasDirectory, stem };
}

function resolveCursorEditorLauncherCommand(
  command: string,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  const parts = splitCursorCommandPath(command);
  if (parts.stem !== CURSOR_EDITOR_BINARY) {
    return undefined;
  }

  if (!parts.hasDirectory) {
    if (findCommandOnPath(DEFAULT_CURSOR_AGENT_BINARY, options)) {
      return { command: DEFAULT_CURSOR_AGENT_BINARY, args: [] };
    }
    const cursorPath = findCommandOnPath(command, options);
    if (cursorPath) {
      const cursorPathParts = splitCursorCommandPath(cursorPath);
      const siblingAgent = resolveCursorSiblingAgentCommand(cursorPathParts, options);
      if (siblingAgent) {
        return siblingAgent;
      }
    }
    return { command: DEFAULT_CURSOR_AGENT_BINARY, args: [] };
  }

  const siblingAgent = resolveCursorSiblingCommand(parts, DEFAULT_CURSOR_AGENT_BINARY, options);
  if (siblingAgent) {
    return siblingAgent;
  }
  if (findCommandOnPath(DEFAULT_CURSOR_AGENT_BINARY, options)) {
    return { command: DEFAULT_CURSOR_AGENT_BINARY, args: [] };
  }
  const siblingLegacyAgent = resolveCursorSiblingCommand(parts, LEGACY_CURSOR_AGENT_BINARY, options);
  if (siblingLegacyAgent) {
    return siblingLegacyAgent;
  }
  return {
    command: `${parts.directory}${LEGACY_CURSOR_AGENT_BINARY}${cursorLegacyFallbackExtension(
      parts,
    )}`,
    args: [],
  };
}

function resolveCursorSiblingAgentCommand(
  parts: CursorCommandPathParts,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  // Cursor editor launchers do not host `cursor agent`; agent commands are top-level binaries.
  return (
    resolveCursorSiblingCommand(parts, DEFAULT_CURSOR_AGENT_BINARY, options) ??
    resolveCursorSiblingCommand(parts, LEGACY_CURSOR_AGENT_BINARY, options)
  );
}

function resolveCursorSiblingCommand(
  parts: CursorCommandPathParts,
  binary: string,
  options: ResolvedCursorAgentCommandOptions,
): CursorAgentCommand | undefined {
  for (const extension of cursorSiblingAgentExtensions(parts)) {
    const siblingAgent = `${parts.directory}${binary}${extension}`;
    if (options.pathExists(siblingAgent)) {
      return { command: siblingAgent, args: [] };
    }
  }
  return undefined;
}

function cursorSiblingAgentExtensions(parts: CursorCommandPathParts): ReadonlyArray<string> {
  const shouldProbeWindowsExtensions = shouldProbeWindowsExtensionsForParts(parts);
  const preferredExtension = isWindowsSafeExecutableExtension(parts.extension)
    ? [parts.extension]
    : [];
  const extensions = shouldProbeWindowsExtensions
    ? [...preferredExtension, ...WINDOWS_EXECUTABLE_EXTENSIONS, ""]
    : [parts.extension];
  return [...new Set(extensions)];
}

function cursorLegacyFallbackExtension(parts: CursorCommandPathParts): string {
  if (!shouldProbeWindowsExtensionsForParts(parts)) {
    return parts.extension;
  }
  return isWindowsSafeExecutableExtension(parts.extension)
    ? parts.extension
    : WINDOWS_BATCH_EXECUTABLE_EXTENSION;
}

function shouldProbeWindowsExtensionsForParts(parts: CursorCommandPathParts): boolean {
  return (
    process.platform === "win32" || parts.directory.includes("\\") || parts.extension.length > 0
  );
}

function isWindowsSafeExecutableExtension(extension: string): boolean {
  return WINDOWS_EXECUTABLE_EXTENSIONS.includes(
    extension as (typeof WINDOWS_EXECUTABLE_EXTENSIONS)[number],
  );
}

function findCommandOnPath(
  command: string,
  options: ResolvedCursorAgentCommandOptions,
): string | undefined {
  const searchPath = options.env.PATH ?? options.env.Path ?? "";
  if (!searchPath.trim()) {
    return undefined;
  }
  const separator =
    options.env.Path !== undefined && options.env.PATH === undefined ? ";" : path.delimiter;
  const extensions =
    process.platform === "win32" && path.extname(command) === ""
      ? WINDOWS_EXECUTABLE_EXTENSIONS
      : [""];
  for (const directory of searchPath.split(separator)) {
    if (!directory.trim()) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (options.pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// Resolves persisted/default Cursor binary settings into the executable Synara should spawn.
export function resolveCursorAgentBinaryPath(binaryPath: string | null | undefined): string {
  const configuredBinaryPath = binaryPath?.trim();
  return !configuredBinaryPath || configuredBinaryPath === LEGACY_CURSOR_AGENT_BINARY
    ? DEFAULT_CURSOR_AGENT_BINARY
    : configuredBinaryPath;
}

// Builds Cursor Agent invocations from either `cursor-agent` or the `cursor` editor launcher.
export function buildCursorAgentCommand(
  binaryPath: string | null | undefined,
  args: ReadonlyArray<string>,
  options: CursorAgentCommandOptions = {},
): CursorAgentCommand {
  const command = resolveCursorAgentBinaryPath(binaryPath);
  const commandOptions = {
    env: options.env ?? process.env,
    pathExists: options.pathExists ?? existsSync,
  };
  const editorLauncher = resolveCursorEditorLauncherCommand(command, commandOptions);
  return editorLauncher
    ? { command: editorLauncher.command, args: [...editorLauncher.args, ...args] }
    : { command, args: [...args] };
}

// Cursor auth/status probes must stay headless so provider refreshes never open login browsers.
export function buildCursorAgentHeadlessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...CURSOR_AGENT_HEADLESS_PROBE_ENV,
  };
}
