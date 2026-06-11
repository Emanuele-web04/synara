// Purpose: Subprocess-activity probing for managed terminals — walks the process
//   tree below a terminal's PID to decide whether it has running children, a
//   provider CLI descendant, or a non-provider subprocess. Platform-specific
//   (Windows CIM, POSIX pgrep/ps) plus a pure tree-inspection pass.
// Layer: Pure module-scope functions over a captured process snapshot or
//   per-pid probes. No class state, no `this`; the runtime injects a
//   TerminalSubprocessChecker and reuses inspectSubprocessActivity per cycle.
// Exports: TerminalSubprocessActivity, TerminalSubprocessChecker,
//   ProcessChildrenMap, normalizeSubprocessActivity, emptySubprocessActivity,
//   inspectSubprocessActivity, captureProcessChildrenMap,
//   defaultSubprocessChecker, POSIX_TREE_WALK_MAX_VISITED.
import path from "node:path";

import {
  deriveTerminalProcessIdentity,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";

import { runProcess } from "../../processRunner";

export const POSIX_TREE_WALK_MAX_VISITED = 256;

export interface TerminalSubprocessActivity {
  cliKind: TerminalCliKind | null;
  hasRunningSubprocess: boolean;
  hasProviderDescendant: boolean;
  hasNonProviderSubprocess: boolean;
}

export type TerminalSubprocessChecker = (
  terminalPid: number,
) => Promise<boolean | TerminalSubprocessActivity>;

export type ProcessChildrenMap = Map<number, Array<{ pid: number; command: string }>>;

const SHELL_LIKE_PROCESS_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "login",
  "nu",
  "screen",
  "sh",
  "tcsh",
  "tmux",
  "zellij",
  "zsh",
]);

export function normalizeSubprocessActivity(
  result: boolean | TerminalSubprocessActivity,
): TerminalSubprocessActivity {
  return typeof result === "boolean"
    ? {
        cliKind: null,
        hasNonProviderSubprocess: result,
        hasProviderDescendant: false,
        hasRunningSubprocess: result,
      }
    : result;
}

export function emptySubprocessActivity(): TerminalSubprocessActivity {
  return {
    cliKind: null,
    hasNonProviderSubprocess: false,
    hasProviderDescendant: false,
    hasRunningSubprocess: false,
  };
}

function isShellLikeProcessName(command: string): boolean {
  const normalized = path.basename(command.trim().split(/\s+/g)[0] ?? "").toLowerCase();
  return SHELL_LIKE_PROCESS_NAMES.has(normalized);
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
  let cliKind: TerminalCliKind | null = null;
  let hasNonProviderSubprocess = false;
  let hasProviderDescendant = false;
  let hasRunningSubprocess = false;
  for (const child of children) {
    const nestedActivity = inspectSubprocessActivity(child.pid, childrenByParentPid);
    const childCliKind = deriveTerminalProcessIdentity(child.command)?.cliKind ?? null;
    if (childCliKind || nestedActivity.hasProviderDescendant) {
      hasProviderDescendant = true;
    }
    if (
      (!childCliKind && !isShellLikeProcessName(child.command)) ||
      nestedActivity.hasNonProviderSubprocess
    ) {
      hasNonProviderSubprocess = true;
    }
    cliKind = cliKind ?? childCliKind ?? nestedActivity.cliKind;
    if (!isShellLikeProcessName(child.command) || nestedActivity.hasRunningSubprocess) {
      hasRunningSubprocess = true;
    }
  }
  return { cliKind, hasNonProviderSubprocess, hasProviderDescendant, hasRunningSubprocess };
}

/**
 * Capture the whole-system process tree as a children-by-ppid map with a single
 * `ps` invocation. Returns null when `ps` is unavailable or fails. Sharing one
 * snapshot across all polled terminals turns an O(running-terminals) burst of
 * full-system scans per poll cycle into a single scan.
 */
export async function captureProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid=,command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) return null;
    if (psResult.stdoutTruncated) return null;

    const childrenByParentPid: ProcessChildrenMap = new Map();
    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      const command = commandParts.join(" ").trim();
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (command.length === 0) continue;
      const siblings = childrenByParentPid.get(ppid) ?? [];
      siblings.push({ pid, command });
      childrenByParentPid.set(ppid, siblings);
    }
    return childrenByParentPid;
  } catch {
    return null;
  }
}

async function checkWindowsSubprocessActivity(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: result.code === 0,
    };
  } catch {
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
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
    if (visited >= POSIX_TREE_WALK_MAX_VISITED) {
      return {
        cliKind: null,
        hasNonProviderSubprocess: true,
        hasProviderDescendant: false,
        hasRunningSubprocess: true,
      };
    }

    const childPids = await readPosixChildPids(parentPid);
    let cliKind: TerminalCliKind | null = null;
    let hasNonProviderSubprocess = false;
    let hasProviderDescendant = false;
    let hasRunningSubprocess = false;

    for (const childPid of childPids) {
      visited += 1;
      const command = await readPosixCommand(childPid);
      if (!command) continue;
      const nestedActivity = await inspectPid(childPid);
      const childCliKind = deriveTerminalProcessIdentity(command)?.cliKind ?? null;
      if (childCliKind || nestedActivity.hasProviderDescendant) {
        hasProviderDescendant = true;
      }
      if (
        (!childCliKind && !isShellLikeProcessName(command)) ||
        nestedActivity.hasNonProviderSubprocess
      ) {
        hasNonProviderSubprocess = true;
      }
      cliKind = cliKind ?? childCliKind ?? nestedActivity.cliKind;
      if (!isShellLikeProcessName(command) || nestedActivity.hasRunningSubprocess) {
        hasRunningSubprocess = true;
      }
    }

    return { cliKind, hasNonProviderSubprocess, hasProviderDescendant, hasRunningSubprocess };
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

export async function defaultSubprocessChecker(
  terminalPid: number,
): Promise<TerminalSubprocessActivity> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return {
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    };
  }
  if (process.platform === "win32") {
    return checkWindowsSubprocessActivity(terminalPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}
