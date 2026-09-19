// FILE: processTreeController.ts
// Purpose: Captures, inspects, and signals owned process trees across platforms.
// Layer: Server platform runtime

import { spawnProcessSync } from "@synara/shared/processRuntime";
import treeKill from "tree-kill";

import { captureWindowsProcessChildrenMap, readWindowsProcessRow } from "./windowsProcessSnapshot";

const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_CAPTURE_ATTEMPTS = 2;
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES = 8_388_608;
// `ps -o lstart=` prints a ctime stamp in five tokens (`Thu Sep 18 14:01:55 2026`).
const PS_LSTART_TOKEN_COUNT = 5;

/** Process-table snapshot keyed by parent PID. */
export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;
/** Live command lines keyed by PID. */
export type ProcessCommandMap = Map<number, string>;

/** One process-table row captured before teardown. */
export interface CapturedProcess {
  readonly pid: number;
  /** Parent PID observed at capture time, when the snapshot provided it. */
  readonly ppid?: number;
  readonly command: string;
  /**
   * Start-time identity (POSIX `lstart`, Windows CIM CreationDate), used to
   * reject PID reuse during delayed escalation.
   */
  readonly startedAt?: string;
}

/** Descendants captured before the root may exit, plus the root row when observed. */
export interface CapturedProcessTree {
  readonly descendants: CapturedProcess[];
  /** The root's own process-table row, when the capture observed it. */
  readonly root?: CapturedProcess;
  /** False when the platform process snapshot failed and descendant absence is unproven. */
  readonly captureComplete?: boolean;
}

/** Re-verification of a captured tree against the live process table. */
export interface CapturedProcessTreeInspection {
  /** False when the process table could not be read, so exit cannot be proven. */
  readonly verified: boolean;
  readonly survivors: CapturedProcess[];
}

/** Signals this boundary is allowed to send. */
export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

/** Synchronous capture/inspect/signal boundary over the platform process table. */
export interface ProcessTreeKiller {
  capture(rootPid: number): CapturedProcessTree;
  inspect?(tree: CapturedProcessTree): CapturedProcessTreeInspection;
  signal(input: {
    readonly rootPid: number;
    readonly signal: TerminalKillSignal;
    readonly tree: CapturedProcessTree;
    /**
     * True only when `tree.descendants` were identity-verified immediately
     * before this signal. This lets Windows use CIM CreationDate verification
     * without falling back to POSIX `ps` before forced descendant cleanup.
     */
    readonly verifiedDescendants?: boolean | undefined;
    readonly includeRootTree?: boolean | undefined;
    readonly onError: (
      error: Error,
      context: { readonly pid: number; readonly source: "tree-kill" | "captured" },
    ) => void;
  }): void;
}

/** One live process-table row probed immediately before a signal. */
type LiveProcessRow = {
  readonly ppid: number;
  readonly pgid?: number;
  readonly startedAt?: string;
  readonly command?: string;
};

/** Injectable platform primitives; every probe fails closed on null/undefined. */
export interface ProcessTreeKillerDependencies {
  readonly captureChildrenMap: () => ProcessChildrenMap | null;
  readonly readCurrentCommands: (pids: readonly number[]) => ProcessCommandMap | null;
  readonly signalPid: (pid: number, signal: TerminalKillSignal) => Error | null;
  /**
   * Windows-only tree primitive invoked once, only after the root's live
   * identity is verified, so taskkill /T retires the verified root and its
   * live tree together. Never invoked on POSIX, on an unverified root, or
   * when `includeRootTree` is false.
   */
  readonly signalTree: (
    rootPid: number,
    signal: TerminalKillSignal,
    callback: (error?: Error | null) => void,
  ) => void;
  /**
   * Live-row probe (CIM on Windows, `ps` elsewhere). Returns a row for a live
   * pid, null when the pid is gone, and undefined when the probe itself
   * failed — callers must treat both non-row answers as "not verified".
   */
  readonly readLiveProcessRow: (pid: number) => LiveProcessRow | null | undefined;
  /** Spawn-time identity lookup; defaults to the registry `noteSpawnedProcess` fills. */
  readonly readSpawnIdentity?: (pid: number) => LiveProcessRow | undefined;
}

/** Overrides for tests and non-host platforms. */
export interface PlatformProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly captureWindowsChildren?: () => Promise<ProcessChildrenMap | null>;
}

/** Parses `ps -eo pid=,ppid=,lstart=,command=` rows; the command is the rest of the line. */
export function parseProcessChildrenMap(psOutput: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...rest] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const startedAt = rest.slice(0, PS_LSTART_TOKEN_COUNT).join(" ");
    const command = rest.slice(PS_LSTART_TOKEN_COUNT).join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, ppid, command, startedAt });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

/** Parses `ps -o pid=,command=` rows keyed by PID. */
export function parseProcessCommandMap(psOutput: string): ProcessCommandMap {
  const commandsByPid: ProcessCommandMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? "";
    if (!Number.isInteger(pid) || command.length === 0) continue;
    commandsByPid.set(pid, command);
  }
  return commandsByPid;
}

/** Flattens the children map into descendants, parents before children. */
export function collectDescendantProcesses(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): CapturedProcess[] {
  const descendants: CapturedProcess[] = [];
  const stack = [...(childrenByParentPid.get(parentPid) ?? [])].reverse();
  const visited = new Set<number>([parentPid]);

  while (stack.length > 0) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) continue;
    visited.add(child.pid);
    descendants.push(child);

    const nestedChildren = childrenByParentPid.get(child.pid) ?? [];
    for (const nestedChild of [...nestedChildren].reverse()) {
      stack.push(nestedChild);
    }
  }

  return descendants;
}

function captureProcessChildrenMapSync(): ProcessChildrenMap | null {
  try {
    const result = spawnProcessSync("ps", ["-eo", "pid=,ppid=,lstart=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_TREE_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return parseProcessChildrenMap(result.stdout);
  } catch {
    return null;
  }
}

function readCurrentCommands(pids: readonly number[]): ProcessCommandMap | null {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) return new Map();
  try {
    const result = spawnProcessSync("ps", ["-p", uniquePids.join(","), "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error) return null;
    if (result.status !== 0) return new Map();
    return parseProcessCommandMap(result.stdout);
  } catch {
    return null;
  }
}

function readPosixLiveProcessRow(pid: number): LiveProcessRow | null | undefined {
  try {
    const result = spawnProcessSync("ps", ["-o", "ppid=,pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error) return undefined;
    const line = result.stdout
      .split(/\r?\n/g)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);
    // `ps` ran and printed no row: the pid is gone, which is not a probe failure.
    if (line === undefined) return null;
    const [ppidRaw, pgidRaw, ...lstartTokens] = line.split(/\s+/g);
    const ppid = Number(ppidRaw);
    const pgid = Number(pgidRaw);
    if (!Number.isInteger(ppid)) return undefined;
    return {
      ppid,
      ...(Number.isInteger(pgid) ? { pgid } : {}),
      ...(lstartTokens.length >= PS_LSTART_TOKEN_COUNT
        ? { startedAt: lstartTokens.slice(0, PS_LSTART_TOKEN_COUNT).join(" ") }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** The real platform probe; spawn recording and the kill guard never use the injected dep. */
function defaultReadLiveProcessRow(pid: number): LiveProcessRow | null | undefined {
  if (globalThis.process.platform === "win32") return readWindowsProcessRow(pid);
  return readPosixLiveProcessRow(pid);
}

function signalPid(pid: number, signal: TerminalKillSignal): Error | null {
  // Never signal launchd/init or a malformed PID: a recycled numeric PID is
  // exactly the failure mode this boundary exists to contain.
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    globalThis.process.kill(pid, signal);
    return null;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ESRCH") return null;
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * True only when the live row proves this is the same process that was
 * captured. A start-time identity on both sides decides alone — argv is
 * legitimately rewritten by interpreters and `process.title`, while a
 * recycled pid always gets a new start time. Without two start times the
 * command must match and a captured ppid, when present, must still hold.
 */
function isSameLiveProcess(
  captured: CapturedProcess,
  row: LiveProcessRow | null | undefined,
): boolean {
  if (row === null || row === undefined) return false;
  if (captured.startedAt !== undefined && row.startedAt !== undefined) {
    return row.startedAt === captured.startedAt;
  }
  if (row.command !== captured.command) return false;
  return captured.ppid === undefined || row.ppid === captured.ppid;
}

/** Locate the root's own process-table row; the map key it sits under is its ppid. */
function capturedRootProcess(
  rootPid: number,
  childrenByParentPid: ProcessChildrenMap,
): CapturedProcess | undefined {
  for (const [ppid, children] of childrenByParentPid) {
    for (const child of children) {
      if (child.pid === rootPid) return { ...child, ppid: child.ppid ?? ppid };
    }
  }
  return undefined;
}

const spawnIdentities = new Map<number, LiveProcessRow>();

/** Records the live OS identity of a just-spawned child; later signals verify against it. */
export function noteSpawnedProcess(pid: number | undefined): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
  const row = defaultReadLiveProcessRow(pid);
  if (row) spawnIdentities.set(pid, row);
}

/** Builds the synchronous killer; injected deps let tests stub every OS probe. */
export function createProcessTreeKiller(
  dependencies: Partial<ProcessTreeKillerDependencies> = {},
): ProcessTreeKiller {
  const deps: ProcessTreeKillerDependencies = {
    captureChildrenMap: captureProcessChildrenMapSync,
    readCurrentCommands,
    signalPid,
    signalTree: treeKill,
    readLiveProcessRow: defaultReadLiveProcessRow,
    ...dependencies,
  };

  return {
    capture: (rootPid) => {
      // PID 1 is launchd/init: never a valid tree root, and walking its
      // children would capture (and later target) the entire login session.
      if (!Number.isInteger(rootPid) || rootPid <= 1) {
        return { descendants: [], captureComplete: false };
      }
      if (globalThis.process.platform === "win32") {
        // The synchronous terminal compatibility API cannot query CIM safely.
        // Windows teardown owners must use captureProcessTree below.
        return { descendants: [], captureComplete: false };
      }
      let childrenByParentPid: ProcessChildrenMap | null = null;
      for (
        let attempt = 0;
        attempt < PROCESS_TREE_CAPTURE_ATTEMPTS && !childrenByParentPid;
        attempt += 1
      ) {
        childrenByParentPid = deps.captureChildrenMap();
      }
      if (!childrenByParentPid) return { descendants: [], captureComplete: false };
      const root = capturedRootProcess(rootPid, childrenByParentPid);
      return {
        descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
        ...(root ? { root } : {}),
        captureComplete: true,
      };
    },
    inspect: (tree) => {
      if (tree.captureComplete === false) {
        return { verified: false, survivors: [...tree.descendants] };
      }
      if (tree.descendants.length === 0) {
        return { verified: true, survivors: [] };
      }
      const currentCommands = deps.readCurrentCommands(
        tree.descendants.map((descendant) => descendant.pid),
      );
      if (currentCommands === null) {
        return { verified: false, survivors: [...tree.descendants] };
      }
      return {
        verified: true,
        survivors: tree.descendants.filter(
          (descendant) => currentCommands.get(descendant.pid) === descendant.command,
        ),
      };
    },
    signal: ({
      rootPid,
      signal,
      tree,
      verifiedDescendants = false,
      includeRootTree = true,
      onError,
    }) => {
      if (!Number.isInteger(rootPid) || rootPid <= 1) return;

      let signalRoot = false;
      if (includeRootTree) {
        const row = deps.readLiveProcessRow(rootPid);
        // A failed probe makes every captured identity unverifiable: signal
        // nothing. A dead root (null) is different — the captured tree can
        // still be proven ours, and its verified descendants must not leak.
        if (row === undefined) return;
        const identity = (deps.readSpawnIdentity ?? ((pid) => spawnIdentities.get(pid)))(rootPid);
        const spawnIdentity = identity?.startedAt !== undefined ? identity : undefined;
        // The live claimant is our spawned child when its start time matches
        // the spawn-time record — or, with no usable record, when it matches
        // the captured root's own identity. A recycled pid keeps ppid === us
        // while belonging to a sibling, so parentage alone never suffices.
        const liveRootVerified =
          row !== null &&
          row.ppid === process.pid &&
          (spawnIdentity !== undefined
            ? row.startedAt === spawnIdentity.startedAt
            : tree.root !== undefined && isSameLiveProcess(tree.root, row));
        // The captured tree is ours when the live root verifies, or when the
        // captured root carries our spawned child's start time — proof that
        // the capture ran while our child held this pid, which survives the
        // root's own exit.
        const treeOwned =
          liveRootVerified ||
          (spawnIdentity !== undefined && tree.root?.startedAt === spawnIdentity.startedAt);
        if (!treeOwned) return;
        signalRoot = liveRootVerified;
      }

      const capturedProcesses = verifiedDescendants
        ? [...tree.descendants]
        : tree.descendants.filter((descendant) =>
            isSameLiveProcess(descendant, deps.readLiveProcessRow(descendant.pid)),
          );
      for (const descendant of capturedProcesses.toReversed()) {
        const error = deps.signalPid(descendant.pid, signal);
        if (error) onError(error, { pid: descendant.pid, source: "captured" });
      }

      if (signalRoot) {
        if (globalThis.process.platform === "win32") {
          // Only taskkill /T reaches the real worker behind a .cmd/cmd.exe
          // shim; the root identity was just proven, so the traversal target
          // is safe. Never a live tree re-walk on POSIX.
          deps.signalTree(rootPid, signal, (error) => {
            if (error) {
              onError(error, { pid: rootPid, source: "tree-kill" });
              return;
            }
            spawnIdentities.delete(rootPid);
          });
        } else {
          const error = deps.signalPid(rootPid, signal);
          if (error) {
            onError(error, { pid: rootPid, source: "captured" });
          } else {
            spawnIdentities.delete(rootPid);
          }
        }
      }
    },
  };
}

function processesByPid(childrenByParentPid: ProcessChildrenMap): Map<number, CapturedProcess> {
  const result = new Map<number, CapturedProcess>();
  for (const children of childrenByParentPid.values()) {
    for (const child of children) result.set(child.pid, child);
  }
  return result;
}

function sameCapturedIdentity(expected: CapturedProcess, current: CapturedProcess): boolean {
  if (expected.command !== current.command) return false;
  if (expected.startedAt === undefined) return true;
  return current.startedAt === expected.startedAt;
}

/** Capture descendants using the native platform observer. */
export async function captureProcessTree(
  rootPid: number,
  options: PlatformProcessTreeOptions = {},
): Promise<CapturedProcessTree> {
  // PID 1 is launchd/init: never a valid tree root.
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return { descendants: [], captureComplete: false };
  }
  const platform = options.platform ?? process.platform;
  const killer = options.processTreeKiller ?? defaultProcessTreeKiller;
  if (platform !== "win32") return killer.capture(rootPid);

  const childrenByParentPid = await (
    options.captureWindowsChildren ?? captureWindowsProcessChildrenMap
  )();
  if (!childrenByParentPid) return { descendants: [], captureComplete: false };
  const root = capturedRootProcess(rootPid, childrenByParentPid);
  return {
    descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
    ...(root ? { root } : {}),
    captureComplete: true,
  };
}

/** A fresh OS observation, independent of Node's potentially delayed exit notification. */
export async function isProcessRunning(
  rootPid: number,
  options: PlatformProcessTreeOptions = {},
): Promise<boolean> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return false;
  try {
    if ((options.platform ?? process.platform) === "win32") {
      const snapshot = await (options.captureWindowsChildren ?? captureWindowsProcessChildrenMap)();
      if (snapshot === null) return false;
      return processesByPid(snapshot).has(rootPid);
    }
    const result = spawnProcessSync("ps", ["-p", String(rootPid), "-o", "stat="], {
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: PROCESS_TREE_SCAN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return false;
    // kill(pid, 0) also succeeds for zombies. Accept only live POSIX process states;
    // Z (zombie), X (dead), missing output, and unknown states cannot prove liveness.
    return /^[RSDITUWt]/.test(result.stdout.trim());
  } catch {
    return false;
  }
}

/** Inspect the exact captured identities; snapshot failure is never interpreted as exit. */
export async function inspectProcessTree(
  tree: CapturedProcessTree,
  options: PlatformProcessTreeOptions = {},
): Promise<CapturedProcessTreeInspection> {
  if (tree.captureComplete === false) {
    return { verified: false, survivors: [...tree.descendants] };
  }
  if (tree.descendants.length === 0) return { verified: true, survivors: [] };

  const platform = options.platform ?? process.platform;
  const killer = options.processTreeKiller ?? defaultProcessTreeKiller;
  if (platform !== "win32") {
    return killer.inspect?.(tree) ?? { verified: false, survivors: [...tree.descendants] };
  }

  const childrenByParentPid = await (
    options.captureWindowsChildren ?? captureWindowsProcessChildrenMap
  )();
  if (!childrenByParentPid) {
    return { verified: false, survivors: [...tree.descendants] };
  }
  const currentByPid = processesByPid(childrenByParentPid);
  return {
    verified: true,
    survivors: tree.descendants.filter((expected) => {
      const current = currentByPid.get(expected.pid);
      return current !== undefined && sameCapturedIdentity(expected, current);
    }),
  };
}

/**
 * Signal an owned tree through one platform boundary. Only PIDs whose live
 * identity still matches the capture are signaled; the root additionally must
 * still be parented to this process and match its spawn-time or captured
 * identity. Unverifiable evidence signals nothing rather than trusting stale
 * PIDs — a recycled numeric PID is the failure mode this boundary contains.
 */
export function signalProcessTree(input: {
  readonly rootPid: number;
  readonly signal: TerminalKillSignal;
  readonly tree?: CapturedProcessTree;
  readonly verifiedDescendants?: boolean;
  readonly includeRootTree?: boolean;
  readonly onError?: (
    error: Error,
    context: { readonly pid: number; readonly source: "tree-kill" | "captured" },
  ) => void;
  readonly processTreeKiller?: ProcessTreeKiller;
}): void {
  (input.processTreeKiller ?? defaultProcessTreeKiller).signal({
    rootPid: input.rootPid,
    signal: input.signal,
    tree: input.tree ?? { descendants: [], captureComplete: false },
    verifiedDescendants: input.verifiedDescendants,
    includeRootTree: input.includeRootTree,
    onError: input.onError ?? (() => undefined),
  });
}

/**
 * Signal one owned child the way the host platform can honor it. Windows
 * routes through the tree boundary because a `.cmd` shim runs under cmd.exe
 * and only taskkill-style traversal reaches the real command behind it. POSIX
 * keeps Node's direct `child.kill`, but only after proving the pid is still
 * ours: the exit notification can lag the real exit and a dead child's pid
 * may already have been recycled by an unrelated process. A failed or
 * negative ownership probe skips the kill.
 */
export function signalOwnedChildProcess(
  child: { readonly pid?: number | undefined; kill(signal?: NodeJS.Signals): unknown },
  signal: TerminalKillSignal,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    signalProcessTree({ rootPid: child.pid, signal });
    return;
  }
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  const row = defaultReadLiveProcessRow(pid);
  if (row === undefined || row === null) return;
  const spawnIdentity = spawnIdentities.get(pid);
  // A recorded spawn identity is authoritative — a recycled pid reused by a
  // sibling keeps ppid === us, so parentage alone cannot authorize the kill.
  const owned =
    spawnIdentity?.startedAt !== undefined
      ? row.startedAt === spawnIdentity.startedAt
      : row.ppid === process.pid;
  if (!owned) return;
  child.kill(signal);
}

/** Shared killer for teardown paths that do not inject probes. */
export const defaultProcessTreeKiller: ProcessTreeKiller = createProcessTreeKiller();

const realProcessKill = process.kill.bind(process);
let killGuardInstalled = false;

/**
 * Refuses broadcast targets (-1, 0, 1) and group signals whose leader is not
 * our live child. A dependency handed a fake or stale handle (pid 1 becomes
 * kill(-1), signalling every user process) cannot turn it into a broadcast.
 * Signal 0 probes on a negative pid pass through: they cannot kill, and
 * blocking liveness checks would break group-exit polling on groups we did
 * not spawn. Positive pids always pass through — verification lives in the
 * signal paths above.
 */
export function installProcessKillGuard(): void {
  if (killGuardInstalled) return;
  killGuardInstalled = true;
  const selfPid = process.pid;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === -1 || pid === 0 || pid === 1) {
      throw Object.assign(new Error(`refusing unsafe signal target ${pid}`), {
        code: "EPERM",
      });
    }
    if (pid < -1 && signal !== 0) {
      const leader = defaultReadLiveProcessRow(-pid);
      if (!leader || leader.ppid !== selfPid || leader.pgid !== -pid) {
        throw Object.assign(new Error(`refusing unverified process-group signal ${pid}`), {
          code: "EPERM",
        });
      }
    }
    return realProcessKill(pid, signal as never);
  }) as typeof process.kill;
}

installProcessKillGuard();
