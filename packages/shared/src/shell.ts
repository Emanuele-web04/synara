// FILE: shell.ts
// Purpose: Shared helpers for probing login-shell environment values safely.
// Exports: shell candidate resolution plus PATH/environment capture utilities.

import * as OS from "node:os";
import { execFileSync } from "node:child_process";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(OS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function resolveLoginShell(
  platform: NodeJS.Platform,
  shell: string | undefined,
): string | undefined {
  return listLoginShellCandidates(platform, shell)[0];
}

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry || seen.has(trimmedEntry)) {
        continue;
      }
      seen.add(trimmedEntry);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`;
}

function buildEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  let value = output.slice(valueStartIndex, endIndex);
  if (value.startsWith("\n")) {
    value = value.slice(1);
  }
  if (value.endsWith("\n")) {
    value = value.slice(0, -1);
  }

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
    encoding: "utf8",
    timeout: 5000,
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

// Windows has no login-shell to probe; the user's persisted environment lives in the
// registry (HKCU + HKLM). A GUI process launched from a stale Explorer inherits an
// outdated environment block, so we read the registry directly to pick up current values.

function isPathName(name: string): boolean {
  return name.toUpperCase() === "PATH";
}

// Merge the Machine and User registry scopes the way Windows composes the environment:
// User scope wins for ordinary variables, and PATH is Machine entries followed by User entries.
export function mergeWindowsScopes(
  machine: Partial<Record<string, string>>,
  user: Partial<Record<string, string>>,
): Partial<Record<string, string>> {
  const merged: Partial<Record<string, string>> = {};

  const assignNonPath = (source: Partial<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(source)) {
      if (isPathName(name)) continue;
      const trimmed = trimNonEmpty(value);
      if (trimmed) {
        merged[name] = trimmed;
      }
    }
  };
  assignNonPath(machine);
  assignNonPath(user);

  const scopePath = (source: Partial<Record<string, string>>): string | undefined => {
    for (const [name, value] of Object.entries(source)) {
      if (isPathName(name)) return trimNonEmpty(value);
    }
    return undefined;
  };
  const combinedPath = [scopePath(machine), scopePath(user)]
    .filter((value): value is string => Boolean(value))
    .join(";");
  if (combinedPath) {
    merged.PATH = combinedPath;
  }

  return merged;
}

export type WindowsEnvironmentReader = (
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

const WINDOWS_ENVIRONMENT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "function dump($s){$m=[ordered]@{};$v=[Environment]::GetEnvironmentVariables($s);",
  "foreach($k in $v.Keys){$m[[string]$k]=[Environment]::ExpandEnvironmentVariables([string]$v[$k])};$m}",
  "$o=[ordered]@{machine=(dump 'Machine');user=(dump 'User')};",
  "[Console]::Out.Write(($o|ConvertTo-Json -Compress -Depth 3))",
].join("");

export const readWindowsPersistentEnvironment: WindowsEnvironmentReader = (
  execFile = execFileSync,
) => {
  const output = execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENVIRONMENT_SCRIPT],
    { encoding: "utf8", timeout: 5000 },
  );

  let parsed: {
    machine?: Partial<Record<string, string>>;
    user?: Partial<Record<string, string>>;
  };
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return {};
  }

  return mergeWindowsScopes(parsed.machine ?? {}, parsed.user ?? {});
};
