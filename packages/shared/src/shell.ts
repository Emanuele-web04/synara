import * as OS from "node:os";
import { execFileSync } from "node:child_process";

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

/** probing a login shell costs ~1s because -ilc sources the interactive rc — the desktop pays it once before spawning the backend, which inherits the result via this marker */
export const SHELL_ENVIRONMENT_HYDRATED_ENV_NAME = "SYNARA_PATH_HYDRATED";
export const SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE = "1";

/** a populated PATH proves nothing — every process inherits one, including the truncated GUI-launch PATH; only the marker may suppress the probe */
export function isShellEnvironmentHydrated(env: NodeJS.ProcessEnv): boolean {
  return (
    env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME] === SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE &&
    trimNonEmpty(env.PATH) !== undefined
  );
}

/** always written explicitly — an inherited marker from an unrelated parent must never suppress a probe this process didn't perform */
export function applyShellEnvironmentHydrationMarker(
  env: NodeJS.ProcessEnv,
  hydrated: boolean,
): NodeJS.ProcessEnv {
  if (hydrated) {
    env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME] = SHELL_ENVIRONMENT_HYDRATED_ENV_VALUE;
  } else {
    delete env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME];
  }
  return env;
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
  const isWindows = platform === "win32";
  const merged: string[] = [];
  const seen = new Set<string>();

  // Windows paths are case-insensitive and tolerate trailing separators — normalize the dedup key on win32 to collapse near-duplicates (first-seen spelling preserved)
  const dedupKey = (entry: string): string =>
    isWindows ? entry.toLowerCase().replace(/[\\/]+$/, "") : entry;

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) {
        continue;
      }
      const key = dedupKey(trimmedEntry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__SYNARA_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__SYNARA_ENV_${name}_END__`;
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

// Windows has no login shell — the persisted env lives in the registry (HKCU+HKLM); a stale-Explorer GUI launch inherits an outdated block

export function isPathName(name: string): boolean {
  return name.toUpperCase() === "PATH";
}

// compose scopes the way Windows does: User wins for ordinary vars, PATH is Machine entries then User entries
export function mergeWindowsScopes(
  machine: Partial<Record<string, string>>,
  user: Partial<Record<string, string>>,
): Partial<Record<string, string>> {
  const merged: Partial<Record<string, string>> = {};

  // env var names are case-insensitive — a later (User) scope must override the earlier (Machine) value, not leave both
  const keyByLowerName = new Map<string, string>();
  const assignNonPath = (source: Partial<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(source)) {
      if (isPathName(name)) continue;
      const trimmed = trimNonEmpty(value);
      if (!trimmed) continue;
      const lowerName = name.toLowerCase();
      const existingKey = keyByLowerName.get(lowerName);
      if (existingKey !== undefined && existingKey !== name) {
        delete merged[existingKey];
      }
      merged[name] = trimmed;
      keyByLowerName.set(lowerName, name);
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

// keep this on powershell.exe 5.1, not pwsh — ConvertTo-Json escapes non-ASCII as \uXXXX so stdout survives the OEM codepage; pwsh emits raw UTF-8 and would corrupt non-ASCII paths
const WINDOWS_ENVIRONMENT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "function dump($s){$m=[ordered]@{};$v=[Environment]::GetEnvironmentVariables($s);",
  "foreach($k in $v.Keys){$m[[string]$k]=[Environment]::ExpandEnvironmentVariables([string]$v[$k])};$m}",
  "$o=[ordered]@{machine=(dump 'Machine');user=(dump 'User')};",
  "[Console]::Out.Write(($o|ConvertTo-Json -Compress -Depth 3))",
].join("");

// resolve the absolute interpreter path so a malicious powershell.exe earlier on PATH can't be executed
function resolveWindowsPowerShellPath(): string {
  const systemRoot = trimNonEmpty(process.env.SystemRoot) ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export const readWindowsPersistentEnvironment: WindowsEnvironmentReader = (
  execFile = execFileSync,
) => {
  const output = execFile(
    resolveWindowsPowerShellPath(),
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
