// FILE: platformProcess.ts
// Purpose: Plans child-process launches behind one cross-platform boundary.
// Layer: Shared platform runtime

import { statSync } from "node:fs";
import os from "node:os";
import { win32 } from "node:path";

import { hasPathSeparator, resolveExecutable } from "./executable.ts";
import { resolveWindowsPowerShellExecutable } from "./platformEnvironment.ts";
import {
  parseWindowsWslUncPath,
  prepareWindowsSafeProcess,
  type WindowsSafeProcessCommand,
} from "./windowsProcess.ts";

export type ProcessExecutionBackend = "native" | "wsl";

/**
 * Best-effort CPU scheduling only: no background I/O or network QoS.
 * Windows callers and unresolved POSIX commands apply this after spawn.
 * Resolved POSIX launches adjust priority before exec so initial agent threads
 * and descendants inherit it.
 */
export function lowerProcessPriority(
  pid: number | undefined,
  input: { readonly platform?: NodeJS.Platform } = {},
): void {
  // PID 0 means this process to os.setPriority; never reprioritize the server.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const priority =
    (input.platform ?? process.platform) === "win32"
      ? os.constants.priority.PRIORITY_BELOW_NORMAL
      : 5;
  try {
    // Preserve inherited lower priority rather than requiring permission to raise it.
    if (os.getPriority(pid) < priority) os.setPriority(pid, priority);
  } catch (cause) {
    console.warn(
      `Failed to lower agent process priority (pid=${pid}, priority=${priority})`,
      cause,
    );
  }
}

export interface ProcessLaunchInput {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Fail before spawn when the native executable cannot be resolved. */
  readonly requireExecutable?: boolean;
  /** Apply CPU priority before exec on POSIX, including Windows launches through WSL. */
  readonly lowerPriority?: boolean;
}

export interface ProcessLaunchPlan extends WindowsSafeProcessCommand {
  readonly requestedCommand: string;
  readonly resolvedCommand: string;
  readonly executionBackend: ProcessExecutionBackend;
  /** A POSIX launcher will attempt priority adjustment before agent exec. */
  readonly priorityBeforeExec?: boolean;
}

export class ExecutableNotFoundError extends Error {
  readonly _tag = "ExecutableNotFoundError";
  readonly command: string;

  constructor(command: string) {
    super(`Command not found: ${command}`);
    this.name = "ExecutableNotFoundError";
    this.command = command;
  }
}

const WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE = 9009;
const WINDOWS_COMMAND_NOT_FOUND_PATTERN = /is not recognized as an internal or external command/iu;

/**
 * True when a finished process reported "command not found" through its exit
 * rather than a spawn error. cmd.exe does this for a `.cmd` shim whose target
 * is missing, so a batch-wrapped launch can only be diagnosed after exit.
 */
export function isCommandNotFoundExit(input: {
  readonly code: number | null;
  readonly stderr: string;
  readonly platform?: NodeJS.Platform;
}): boolean {
  if ((input.platform ?? process.platform) !== "win32") return false;
  if (input.code === WINDOWS_COMMAND_NOT_FOUND_EXIT_CODE) return true;
  return WINDOWS_COMMAND_NOT_FOUND_PATTERN.test(input.stderr);
}

function explicitPowerShellScript(
  command: string,
  platform: NodeJS.Platform,
  cwd: string | undefined,
): string | null {
  if (platform !== "win32" || !hasPathSeparator(command) || !/\.ps1$/iu.test(command)) {
    return null;
  }
  const scriptPath = win32.isAbsolute(command)
    ? command
    : win32.resolve(cwd ?? process.cwd(), command);
  try {
    return statSync(scriptPath).isFile() ? command : null;
  } catch {
    return null;
  }
}

function nativeExecutable(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string | null {
  return (
    explicitPowerShellScript(command, platform, cwd) ??
    resolveExecutable(command, { platform, env, ...(cwd !== undefined ? { cwd } : {}) })
  );
}

function priorityExecArgs(
  command: string,
  args: ReadonlyArray<string>,
  priority: number,
): string[] {
  return [
    "-c",
    'renice "$1" -p "$$" >/dev/null 2>/dev/null || printf "%s\\n" "Synara: failed to lower agent process priority; continuing" >&2; shift; exec "$@"',
    "synara-agent-priority",
    String(priority),
    command,
    ...args,
  ];
}

function inheritedAgentPriority(): number {
  try {
    // Do not raise an agent when the server already inherited a lower priority.
    return Math.max(5, os.getPriority());
  } catch (cause) {
    console.warn("Failed to read inherited agent process priority; using nice +5", cause);
    return 5;
  }
}

/**
 * Converts one logical command into the exact executable/argv pair the host
 * runtime must use. Application and provider code must not reproduce the
 * Windows `.cmd`, `cmd.exe`, PATHEXT, or WSL rules represented here.
 */
export function prepareProcess(
  command: string,
  args: ReadonlyArray<string>,
  input: ProcessLaunchInput = {},
): ProcessLaunchPlan {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const wslWorkspace = platform === "win32" && input.cwd ? parseWindowsWslUncPath(input.cwd) : null;

  if (wslWorkspace) {
    // The Windows launcher priority does not set Linux guest scheduling. Adjust
    // the guest shell before exec, with literal argv and a logged fail-open fallback.
    const guestCommand = input.lowerPriority ? "/bin/sh" : command;
    const guestArgs = input.lowerPriority ? priorityExecArgs(command, args, 5) : args;
    const prepared = prepareWindowsSafeProcess(guestCommand, guestArgs, {
      platform,
      cwd: input.cwd,
      env,
    });
    return {
      ...prepared,
      requestedCommand: command,
      resolvedCommand: command,
      executionBackend: "wsl",
      priorityBeforeExec: input.lowerPriority === true,
    };
  }

  const resolved = nativeExecutable(command, platform, env, input.cwd);
  if (input.requireExecutable && resolved === null) {
    throw new ExecutableNotFoundError(command);
  }
  const resolvedCommand = resolved ?? command;

  if (platform !== "win32") {
    // Let the runtime preserve ENOENT/EACCES for unresolved commands instead of
    // converting startup errors to shell exit codes. A successful direct spawn
    // still receives best-effort post-spawn priority from the runtime boundary.
    let priorityBeforeExec = input.lowerPriority === true && resolved !== null;
    if (priorityBeforeExec && resolveExecutable("/bin/sh", { platform, env }) === null) {
      console.warn("Agent priority launcher /bin/sh is unavailable; using post-spawn priority");
      priorityBeforeExec = false;
    }
    return {
      command: priorityBeforeExec ? "/bin/sh" : resolvedCommand,
      args: priorityBeforeExec
        ? priorityExecArgs(resolvedCommand, args, inheritedAgentPriority())
        : [...args],
      shell: false,
      requestedCommand: command,
      resolvedCommand,
      executionBackend: "native",
      priorityBeforeExec,
    };
  }

  if (/\.ps1$/iu.test(resolvedCommand)) {
    return {
      command: resolveWindowsPowerShellExecutable(env),
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedCommand, ...args],
      shell: false,
      windowsHide: true,
      requestedCommand: command,
      resolvedCommand,
      executionBackend: "native",
    };
  }

  const prepared = prepareWindowsSafeProcess(resolvedCommand, args, {
    platform,
    cwd: input.cwd,
    env,
  });
  return {
    ...prepared,
    requestedCommand: command,
    resolvedCommand,
    executionBackend: "native",
  };
}
