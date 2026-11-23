// FILE: platformEnvironment.ts
// Purpose: Resolves platform-owned paths from an already hydrated environment.
// Layer: Shared platform runtime

import * as Path from "node:path";
import { homedir } from "node:os";

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Uses the home variable the child process reads for this platform. */
export function resolvePlatformHomeDirectory(env: NodeJS.ProcessEnv): string {
  return trimNonEmpty(process.platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir();
}

export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(env.SystemRoot) ?? trimNonEmpty(env.SYSTEMROOT) ?? "C:\\Windows";
}

export function resolveWindowsSystemExecutable(
  relativeSegments: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return Path.win32.join(resolveWindowsSystemRoot(env), ...relativeSegments);
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  return (
    trimNonEmpty(env.ComSpec) ??
    trimNonEmpty(env.COMSPEC) ??
    resolveWindowsSystemExecutable(["System32", "cmd.exe"], env)
  );
}

export function resolveWindowsWslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(["System32", "wsl.exe"], env);
}

/** Resolve the system tree terminator without consulting the user's PATH. */
export function resolveWindowsTaskkillExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(["System32", "taskkill.exe"], env);
}

export function resolveWindowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    env,
  );
}
