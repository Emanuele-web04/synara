// FILE: codexCliExecutable.ts
// Purpose: Resolves the native Codex CLI executable on Windows before batch shims.
// Layer: Shared Node runtime utility

import { statSync } from "node:fs";
import * as Path from "node:path";

import {
  resolveWindowsCommandCandidates,
  resolveWindowsCommandPath,
  type WindowsSafeProcessInput,
} from "./windowsProcess.ts";

interface FileStatLike {
  isFile(): boolean;
}

type StatSyncLike = (path: string) => FileStatLike;

export interface CodexCliExecutableInput extends WindowsSafeProcessInput {
  readonly statSync?: StatSyncLike | undefined;
}

const DEFAULT_CODEX_COMMAND = "codex";
const WINDOWS_NATIVE_EXECUTABLE_PATTERN = /\.(?:exe|com)$/i;
const WINDOWS_BATCH_EXECUTABLE_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_FULLY_QUALIFIED_PATH_PATTERN =
  /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i;

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (typeof exact === "string") {
    return exact;
  }

  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === normalizedName && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function nonEmptyEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = readEnvironmentValue(env, name)?.trim();
  return value ? value : undefined;
}

function isAbsoluteRegularFile(candidate: string, readStat: StatSyncLike): boolean {
  if (
    !Path.win32.isAbsolute(candidate) ||
    !WINDOWS_FULLY_QUALIFIED_PATH_PATTERN.test(candidate)
  ) {
    return false;
  }

  try {
    return readStat(candidate).isFile();
  } catch {
    return false;
  }
}

function firstValidCandidate(
  candidates: ReadonlyArray<string>,
  pattern: RegExp,
  readStat: StatSyncLike,
): string | undefined {
  return candidates.find(
    (candidate) => pattern.test(candidate) && isAbsoluteRegularFile(candidate, readStat),
  );
}

function validCodexExecutableInDirectory(
  directory: string | undefined,
  readStat: StatSyncLike,
): string | undefined {
  if (!directory) {
    return undefined;
  }
  const candidate = Path.win32.join(directory, "codex.exe");
  return isAbsoluteRegularFile(candidate, readStat) ? candidate : undefined;
}

function validNpmCodexShim(
  appData: string | undefined,
  readStat: StatSyncLike,
): string | undefined {
  if (!appData) {
    return undefined;
  }
  const candidate = Path.win32.join(appData, "npm", "codex.cmd");
  return isAbsoluteRegularFile(candidate, readStat) ? candidate : undefined;
}

export function resolveCodexCliExecutable(
  command: string,
  input: CodexCliExecutableInput = {},
): string {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return command;
  }
  if (command.trim().toLowerCase() !== DEFAULT_CODEX_COMMAND) {
    return resolveWindowsCommandPath(command, input);
  }

  const env = input.env ?? process.env;
  const readStat = input.statSync ?? statSync;
  const whereCandidates = resolveWindowsCommandCandidates(DEFAULT_CODEX_COMMAND, input);
  const localAppData = nonEmptyEnvironmentValue(env, "LOCALAPPDATA");
  const standaloneInstallDirectory = localAppData
    ? Path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin")
    : undefined;

  return (
    firstValidCandidate(whereCandidates, WINDOWS_NATIVE_EXECUTABLE_PATTERN, readStat) ??
    validCodexExecutableInDirectory(
      nonEmptyEnvironmentValue(env, "CODEX_INSTALL_DIR"),
      readStat,
    ) ??
    validCodexExecutableInDirectory(standaloneInstallDirectory, readStat) ??
    firstValidCandidate(whereCandidates, WINDOWS_BATCH_EXECUTABLE_PATTERN, readStat) ??
    validNpmCodexShim(nonEmptyEnvironmentValue(env, "APPDATA"), readStat) ??
    DEFAULT_CODEX_COMMAND
  );
}
