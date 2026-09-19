/**
 * What a nested desktop leaves behind, and who cleans it up.
 *
 * A nested session is two long-lived processes this server starts — a private
 * `dbus-daemon` and a `kwin_wayland` that forks its own Xwayland — plus every
 * application the agent launched into it. Disposing the session ends all of
 * them, and so does an orderly server shutdown. Neither happens when the server
 * is SIGKILLed, when the machine's OOM killer picks it, or when a developer
 * kills a stuck process: the compositor keeps running, its Xwayland keeps
 * running, and its bus keeps serving, with nothing left that knows about them.
 * Ten crashes later the host has ten invisible desktops on it.
 *
 * So every session writes a marker naming its processes before it is handed
 * out, and the next server sweeps the markers whose owner is gone. Identity is
 * checked twice before anything is signalled — the recorded argv *and* the
 * kernel's own process start time — because a pid on its own is a number the
 * OS is free to hand to something else, and "reap the stale desktop" must never
 * become "kill whatever now holds pid 4242".
 */
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { teardownProviderProcessTree } from "../platform/supervisedProcessTeardown.ts";
import type { ProcessTreeTeardown } from "./supervisedProcess.ts";

const MARKER_SUFFIX = ".json";
const STATE_DIRECTORY_NAME = "synara-nested-sessions";
const EXIT_POLL_MS = 50;
const EXIT_POLL_TIMEOUT_MS = 5_000;

/** One process of a nested session, with enough identity to re-find it safely. */
export interface NestedSessionProcess {
  readonly pid: number;
  /** The argv as spawned, joined by spaces — matched against /proc at sweep time. */
  readonly command: string;
  /**
   * The kernel's start time for this pid (clock ticks since boot). A pid can be
   * reused; a pid with the same argv *and* the same start time cannot.
   */
  readonly startTime: string | undefined;
}

export interface NestedSessionMarker {
  readonly serverPid: number;
  readonly startedAt: number;
  readonly waylandDisplay: string;
  readonly processes: readonly NestedSessionProcess[];
  /** The private XDG runtime directory this session made, if it made one. */
  readonly runtimeDirectory?: string;
}

export interface NestedSessionRegistryDependencies {
  /** Where markers live; defaults to the session state directory of `hostEnv`. */
  readonly stateDirectory?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly serverPid?: number;
  readonly processAlive?: (pid: number) => boolean;
  readonly processStartTime?: (pid: number) => string | undefined;
  readonly processCommand?: (pid: number) => string | undefined;
  readonly teardownProcessTree?: ProcessTreeTeardown;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Where a host's session markers live. `XDG_RUNTIME_DIR` is the right home:
 * the kernel-backed tmpfs is wiped when the user's last session ends, so a
 * marker can never outlive the boot whose pids it names. The temp directory is
 * only the fallback for a server with no runtime directory at all, where stale
 * markers are still harmless — every pid in them fails the identity check.
 */
export function nestedSessionStateDirectory(hostEnv: NodeJS.ProcessEnv = process.env): string {
  return join(hostEnv.XDG_RUNTIME_DIR ?? tmpdir(), STATE_DIRECTORY_NAME);
}

/** The process start time the kernel reports, or `undefined` off Linux. */
export function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22, counted after the comm field, which is parenthesised and may
    // itself contain spaces — so the split starts after the last ')'.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return afterComm[19];
  } catch {
    return undefined;
  }
}

/** The argv a pid was started with, NUL-separated in /proc, or `undefined`. */
export function readProcessCommand(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Records a running session, so a server that never gets to dispose it still
 * leaves something behind that names what to kill.
 *
 * Written before the session is handed to a caller and deleted on dispose, so
 * the window in which a marker exists is exactly the window in which processes
 * exist that nothing else would reap.
 */
export async function writeNestedSessionMarker(
  marker: NestedSessionMarker,
  dependencies: NestedSessionRegistryDependencies = {},
): Promise<string> {
  const directory = resolveStateDirectory(dependencies);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${marker.serverPid}-${marker.waylandDisplay}${MARKER_SUFFIX}`);
  await writeFile(path, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function removeNestedSessionMarker(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Ends every nested session whose server is gone, and returns what it reaped.
 *
 * Best effort by contract: this runs on the path to booting a desktop, and a
 * host whose `/proc` cannot be read, or whose stale compositor refuses to die,
 * must not be a host that cannot start a new desktop. Anything it cannot prove
 * is left alone rather than signalled on a guess.
 */
export async function reapStaleNestedSessions(
  dependencies: NestedSessionRegistryDependencies = {},
): Promise<readonly string[]> {
  const directory = resolveStateDirectory(dependencies);
  const serverPid = dependencies.serverPid ?? process.pid;
  const alive = dependencies.processAlive ?? isProcessAlive;
  const entries = await readdir(directory).catch(() => [] as string[]);
  const reaped: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(MARKER_SUFFIX)) continue;
    const path = join(directory, entry);
    const marker = await readMarker(path);
    if (!marker) {
      // Unreadable or truncated: there is nothing here to act on, and leaving
      // it would make every later sweep re-read it forever.
      await removeNestedSessionMarker(path);
      continue;
    }
    // A live owner is the whole reason to leave a session alone, and this
    // server is its own most important live owner.
    if (marker.serverPid === serverPid || alive(marker.serverPid)) continue;
    for (const recorded of marker.processes) {
      await terminateStaleProcess(recorded, dependencies);
    }
    if (marker.runtimeDirectory) {
      await rm(marker.runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    await removeNestedSessionMarker(path);
    reaped.push(marker.waylandDisplay);
  }
  return reaped;
}

async function terminateStaleProcess(
  recorded: NestedSessionProcess,
  dependencies: NestedSessionRegistryDependencies,
): Promise<void> {
  const alive = dependencies.processAlive ?? isProcessAlive;
  const readCommand = dependencies.processCommand ?? readProcessCommand;
  const readStartTime = dependencies.processStartTime ?? readProcessStartTime;
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 0 || !alive(recorded.pid)) return;
  // Both halves of the identity, because either alone can be coincidence: argv
  // is generic for a private bus daemon, and a pid is a number the OS reuses.
  if (readCommand(recorded.pid) !== recorded.command) return;
  if (recorded.startTime !== undefined && readStartTime(recorded.pid) !== recorded.startTime)
    return;
  const teardown = dependencies.teardownProcessTree ?? teardownProviderProcessTree;
  await teardown({
    rootPid: recorded.pid,
    rootExited: waitForPidExit(recorded.pid, dependencies),
  }).catch(() => undefined);
}

/** Resolves once the pid is gone, so the teardown can prove its own work. */
async function waitForPidExit(
  pid: number,
  dependencies: NestedSessionRegistryDependencies,
): Promise<void> {
  const alive = dependencies.processAlive ?? isProcessAlive;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + EXIT_POLL_TIMEOUT_MS;
  while (alive(pid)) {
    if (now() >= deadline) return;
    await sleep(EXIT_POLL_MS);
  }
}

async function readMarker(path: string): Promise<NestedSessionMarker | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<NestedSessionMarker>;
    if (typeof candidate.serverPid !== "number" || !Array.isArray(candidate.processes)) {
      return undefined;
    }
    return {
      serverPid: candidate.serverPid,
      startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : 0,
      waylandDisplay:
        typeof candidate.waylandDisplay === "string" ? candidate.waylandDisplay : "unknown",
      processes: candidate.processes.filter(
        (entry): entry is NestedSessionProcess =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as NestedSessionProcess).pid === "number" &&
          typeof (entry as NestedSessionProcess).command === "string",
      ),
      ...(typeof candidate.runtimeDirectory === "string"
        ? { runtimeDirectory: candidate.runtimeDirectory }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function resolveStateDirectory(dependencies: NestedSessionRegistryDependencies): string {
  return dependencies.stateDirectory ?? nestedSessionStateDirectory(dependencies.hostEnv);
}
