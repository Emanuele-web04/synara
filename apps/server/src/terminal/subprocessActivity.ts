// FILE: subprocessActivity.ts
// Purpose: Detects subprocess and coding-provider activity below terminal PTY processes.
// Layer: Terminal infrastructure

import fs from "node:fs/promises";
import path from "node:path";

import {
  deriveTerminalProcessIdentity,
  type TerminalCliKind,
} from "@synara/shared/terminalThreads";

import { runProcess } from "../processRunner";
import { parseProcessChildrenMap, type ProcessChildrenMap } from "./processTreeKiller";
import { captureWindowsProcessChildrenMap } from "./windowsProcessSnapshot";

const POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED = 256;
const DEFAULT_LINUX_PROC_ROOT = "/proc";

export interface TerminalSubprocessActivity {
  cliKind: TerminalCliKind | null;
  hasRunningSubprocess: boolean;
  hasProviderDescendant: boolean;
  hasNonProviderSubprocess: boolean;
}

const SHELL_LIKE_PROCESS_NAMES = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "login",
  "nu",
  "powershell",
  "pwsh",
  "screen",
  "sh",
  "tcsh",
  "tmux",
  "zellij",
  "zsh",
]);

function emptySubprocessActivity(): TerminalSubprocessActivity {
  return {
    cliKind: null,
    hasNonProviderSubprocess: false,
    hasProviderDescendant: false,
    hasRunningSubprocess: false,
  };
}

function processExecutableName(command: string): string {
  const firstToken = /^\s*"([^"]+)"/.exec(command)?.[1] ?? command.trim().split(/\s+/g)[0] ?? "";
  const normalizedPath = firstToken.replaceAll("\\", "/");
  return path
    .basename(normalizedPath)
    .replace(/\.(?:cmd|com|exe)$/i, "")
    .toLowerCase();
}

function isShellLikeProcessName(command: string): boolean {
  return SHELL_LIKE_PROCESS_NAMES.has(processExecutableName(command));
}

function deriveProcessCliKind(command: string): TerminalCliKind | null {
  return (
    deriveTerminalProcessIdentity(command)?.cliKind ??
    deriveTerminalProcessIdentity(processExecutableName(command))?.cliKind ??
    null
  );
}

function includeChildActivity(
  activity: TerminalSubprocessActivity,
  command: string,
  nestedActivity: TerminalSubprocessActivity,
): TerminalSubprocessActivity {
  const childCliKind = deriveProcessCliKind(command);
  const isShellLike = isShellLikeProcessName(command);
  return {
    cliKind: activity.cliKind ?? childCliKind ?? nestedActivity.cliKind,
    hasProviderDescendant:
      activity.hasProviderDescendant ||
      childCliKind !== null ||
      nestedActivity.hasProviderDescendant,
    hasNonProviderSubprocess:
      activity.hasNonProviderSubprocess ||
      (!childCliKind && !isShellLike) ||
      nestedActivity.hasNonProviderSubprocess,
    hasRunningSubprocess:
      activity.hasRunningSubprocess || !isShellLike || nestedActivity.hasRunningSubprocess,
  };
}

/**
 * Walk the process tree below `parentPid` using a pre-captured children map.
 * Pure and synchronous, so a single captured snapshot can be reused across many
 * polled terminals without re-scanning the system per terminal.
 */
export function inspectSubprocessActivity(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): TerminalSubprocessActivity {
  const children = childrenByParentPid.get(parentPid) ?? [];
  let activity = emptySubprocessActivity();
  for (const child of children) {
    const nestedActivity = inspectSubprocessActivity(child.pid, childrenByParentPid);
    activity = includeChildActivity(activity, child.command, nestedActivity);
  }
  return activity;
}

/**
 * Capture the whole-system process tree as a children-by-ppid map with a single
 * `ps` invocation. Returns null when `ps` is unavailable or fails. Sharing one
 * snapshot across all polled terminals turns an O(running-terminals) burst of
 * full-system scans per poll cycle into a single scan.
 */
export async function captureProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  try {
    // Use the runner's bounded 8 MiB budget: ordinary process tables with long
    // command lines exceed 256 KiB. Incomplete snapshots still fail closed.
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid=,command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) return null;
    if (psResult.stdoutTruncated) return null;

    return parseProcessChildrenMap(psResult.stdout);
  } catch {
    return null;
  }
}

async function readPosixChildPids(parentPid: number): Promise<number[]> {
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(parentPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 1) return [];
    if (pgrepResult.code !== 0) return [];
    return pgrepResult.stdout
      .split(/\s+/g)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function readPosixCommand(pid: number): Promise<string> {
  try {
    const psResult = await runProcess("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    return psResult.code === 0 ? psResult.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function checkPosixSubprocessActivityByTreeWalk(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  let visited = 0;

  // Fallback for hosts where `ps -eo` was unavailable/truncated. It is slower,
  // but bounded and only used when the shared snapshot cannot be trusted.
  const inspectPid = async (parentPid: number): Promise<TerminalSubprocessActivity> => {
    if (visited >= POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: true,
        hasProviderDescendant: false,
        hasRunningSubprocess: true,
      };
    }

    const childPids = await readPosixChildPids(parentPid);
    let activity = emptySubprocessActivity();
    for (const childPid of childPids) {
      visited += 1;
      const command = await readPosixCommand(childPid);
      if (!command) continue;
      const nestedActivity = await inspectPid(childPid);
      activity = includeChildActivity(activity, command, nestedActivity);
    }

    return activity;
  };

  return inspectPid(terminalPid);
}

async function checkPosixSubprocessActivity(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  // Cheap fast path: skip the full process scan when the shell has no children.
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 1) return emptySubprocessActivity();
    if (pgrepResult.code === 0 && pgrepResult.stdout.trim().length === 0) {
      return emptySubprocessActivity();
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  const childrenByParentPid = await captureProcessChildrenMap();
  if (childrenByParentPid === null) return checkPosixSubprocessActivityByTreeWalk(terminalPid);
  return inspectSubprocessActivity(terminalPid, childrenByParentPid);
}

async function readLinuxProcChildPids(
  parentPid: number,
  procRoot: string,
): Promise<number[] | null> {
  try {
    const taskEntries = await fs.readdir(path.join(procRoot, String(parentPid), "task"));
    const childPids = new Set<number>();
    let readAnyChildrenFile = false;
    await Promise.all(
      taskEntries.map(async (tid) => {
        try {
          const raw = await fs.readFile(
            path.join(procRoot, String(parentPid), "task", tid, "children"),
            "utf8",
          );
          readAnyChildrenFile = true;
          for (const token of raw.trim().split(/\s+/g)) {
            if (!token) continue;
            const pid = Number(token);
            if (Number.isInteger(pid) && pid > 0) {
              childPids.add(pid);
            }
          }
        } catch {
          // A thread can exit mid-read or CONFIG_PROC_CHILDREN may be disabled.
        }
      }),
    );
    return readAnyChildrenFile ? [...childPids] : null;
  } catch {
    return null;
  }
}

async function readLinuxProcCommand(pid: number, procRoot: string): Promise<string> {
  try {
    const rawCmdline = await fs.readFile(path.join(procRoot, String(pid), "cmdline"));
    const decoded = rawCmdline.toString("utf8").replaceAll("\u0000", " ").trim();
    if (decoded.length > 0) {
      return decoded;
    }
  } catch {
    // Fall back to /proc/<pid>/comm for kernel threads or races.
  }
  try {
    return (await fs.readFile(path.join(procRoot, String(pid), "comm"), "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Inspect subprocess activity below `terminalPid` directly through Linux `/proc`
 * without spawning `pgrep` or `ps`. Returns `null` when `/proc` child listings
 * are unavailable (e.g., restricted container or non-Linux kernel) so callers
 * can fall back to the POSIX `ps` path.
 */
export async function checkLinuxProcSubprocessActivity(
  terminalPid: number,
  procRoot = DEFAULT_LINUX_PROC_ROOT,
): Promise<TerminalSubprocessActivity | null> {
  let visited = 0;

  const inspectPid = async (parentPid: number): Promise<TerminalSubprocessActivity | null> => {
    if (visited >= POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: true,
        hasProviderDescendant: false,
        hasRunningSubprocess: true,
      };
    }

    const childPids = await readLinuxProcChildPids(parentPid, procRoot);
    if (childPids === null) {
      return parentPid === terminalPid ? null : emptySubprocessActivity();
    }
    if (childPids.length === 0) {
      return emptySubprocessActivity();
    }

    let activity = emptySubprocessActivity();
    for (const childPid of childPids) {
      visited += 1;
      const command = await readLinuxProcCommand(childPid, procRoot);
      if (!command) continue;
      const nestedActivity = (await inspectPid(childPid)) ?? emptySubprocessActivity();
      activity = includeChildActivity(activity, command, nestedActivity);
    }

    return activity;
  };

  return inspectPid(terminalPid);
}

/**
 * Build a process children map from Linux `/proc` without spawning `ps`.
 * Used on Linux when polling multiple terminals in one pass.
 */
export async function captureLinuxProcChildrenMap(
  procRoot = DEFAULT_LINUX_PROC_ROOT,
): Promise<ProcessChildrenMap | null> {
  try {
    const entries = await fs.readdir(procRoot);
    const pids = entries
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number(name))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    if (pids.length === 0) return null;

    const childrenByParentPid: ProcessChildrenMap = new Map();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const stat = await fs.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
          // Process comm sits inside (...) and may contain spaces or parentheses;
          // parse ppid strictly after the final ')'.
          const commEnd = stat.lastIndexOf(")");
          if (commEnd === -1) return;
          const fields = stat
            .slice(commEnd + 2)
            .trim()
            .split(/\s+/g);
          const ppid = Number(fields[1]);
          if (!Number.isInteger(ppid) || ppid < 0) return;
          const command = await readLinuxProcCommand(pid, procRoot);
          if (!command) return;
          const siblings = childrenByParentPid.get(ppid) ?? [];
          siblings.push({ pid, command });
          childrenByParentPid.set(ppid, siblings);
        } catch {
          // Process may exit while iterating /proc.
        }
      }),
    );

    return childrenByParentPid.size > 0 ? childrenByParentPid : null;
  } catch {
    return null;
  }
}

export async function defaultSubprocessChecker(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return emptySubprocessActivity();
  }
  if (process.platform === "win32") {
    const childrenByParentPid = await captureWindowsProcessChildrenMap();
    return childrenByParentPid === null
      ? emptySubprocessActivity()
      : inspectSubprocessActivity(terminalPid, childrenByParentPid);
  }
  if (process.platform === "linux") {
    const procActivity = await checkLinuxProcSubprocessActivity(terminalPid);
    if (procActivity !== null) {
      return procActivity;
    }
  }
  return checkPosixSubprocessActivity(terminalPid);
}
