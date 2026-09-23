/**
 * What a nested desktop leaves behind, and who cleans it up.
 *
 * A nested session is a handful of long-lived processes this server starts — a
 * private `dbus-daemon`, a `kwin_wayland` that forks its own Xwayland, and an
 * accessibility bus launcher when perception is on — plus every application
 * the agent launched into it. Disposing the session ends all of them, and so
 * does an orderly server shutdown. Neither happens when the server is
 * SIGKILLed, when the machine's OOM killer picks it, or when a developer kills
 * a stuck process: the compositor keeps running, its Xwayland keeps running,
 * and its bus keeps serving, with nothing left that knows about them. Ten
 * crashes later the host has ten invisible desktops on it.
 *
 * So every session writes a marker naming its processes the moment the first
 * one exists, keeps it current as more are spawned, and every later server
 * sweeps the markers whose owner is gone — when its nested backend is
 * constructed, and again before each boot.
 *
 * A marker is an instruction to signal pids and delete a directory, so the
 * sweep believes as little of it as it can:
 *
 * - Markers live only in a directory this user owns, with mode 0700, that is
 *   not a symlink: the runtime directory, or the user's cache directory when
 *   there is none. Never the shared temp directory, where anyone can create the
 *   directory first and fill it with markers of their own.
 * - A session directory is deleted only when it is one this module names —
 *   directly inside the marker directory, with the session's id for a name.
 * - A pid is signalled only when its argv *and* the kernel's start time match
 *   what was recorded, and only when the recorded executable is one a nested
 *   session actually runs (or an application this server recorded launching).
 *   A pid on its own is a number the OS is free to hand to something else, and
 *   "reap the stale desktop" must never become "kill whatever now holds pid
 *   4242".
 * - The owner is identified the same way: a server pid with its start time, so
 *   a new process that inherited a dead server's pid — the ordinary case in a
 *   container, where the server is often pid 1 on every run — does not keep
 *   the dead server's desktop alive forever.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { teardownProviderProcessTree } from "../platform/supervisedProcessTeardown.ts";
import type { ProcessTreeTeardown } from "./supervisedProcess.ts";

const MARKER_SUFFIX = ".json";
const STATE_DIRECTORY_NAME = "synara-nested-sessions";
/** `<server pid>-<8 hex>`: what a session directory and its marker are named. */
const SESSION_ID_PATTERN = /^\d+-[0-9a-f]{8}$/;
const EXIT_POLL_MS = 50;
const EXIT_POLL_TIMEOUT_MS = 5_000;

/**
 * What a process is to its session, which decides whether a sweep may signal
 * it. Every role but `app` names the one executable that plays it; an app is
 * whatever the agent launched, so it is trusted only because this server wrote
 * it down, and still only with a matching argv and start time.
 */
export type NestedSessionProcessRole =
  | "compositor"
  | "bus"
  | "xwayland"
  | "accessibility"
  | "accessibility-registry"
  | "app";

const ROLE_EXECUTABLES: Readonly<Record<Exclude<NestedSessionProcessRole, "app">, string>> = {
  compositor: "kwin_wayland",
  bus: "dbus-daemon",
  xwayland: "Xwayland",
  accessibility: "at-spi-bus-launcher",
  "accessibility-registry": "at-spi2-registryd",
};

/** One process of a nested session, with enough identity to re-find it safely. */
export interface NestedSessionProcess {
  readonly pid: number;
  /** The argv as `/proc/<pid>/cmdline` reads it, joined by spaces. */
  readonly command: string;
  /**
   * The kernel's start time for this pid (clock ticks since boot). A pid can be
   * reused; a pid with the same argv *and* the same start time cannot.
   */
  readonly startTime: string;
  readonly role: NestedSessionProcessRole;
}

export interface NestedSessionMarker {
  readonly serverPid: number;
  /** The server's own start time, so a reused pid is not mistaken for it. */
  readonly serverStartTime: string | undefined;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly waylandDisplay: string;
  readonly processes: readonly NestedSessionProcess[];
  /** The session's private XDG runtime directory, deleted with it. */
  readonly runtimeDirectory?: string;
}

export interface NestedSessionRegistryDependencies {
  /** Where markers live; defaults to the private state directory of `hostEnv`. */
  readonly stateDirectory?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly serverPid?: number;
  readonly serverStartTime?: string | undefined;
  /** The uid every marker, and the directory holding it, must belong to. */
  readonly uid?: number;
  readonly processAlive?: (pid: number) => boolean;
  readonly processStartTime?: (pid: number) => string | undefined;
  readonly processCommand?: (pid: number) => string | undefined;
  readonly teardownProcessTree?: ProcessTreeTeardown;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Where a host's session markers and session directories live, or `undefined`
 * when there is nowhere private to put them.
 *
 * `XDG_RUNTIME_DIR` is the right home: a per-user tmpfs the system wipes when
 * the user's last session ends, so a marker can never outlive the boot whose
 * pids it names. Without one, the user's cache directory. Never the shared
 * temp directory — see the module comment.
 */
export function nestedSessionStateDirectory(
  hostEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runtime = hostEnv.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, STATE_DIRECTORY_NAME);
  const cache =
    hostEnv.XDG_CACHE_HOME && isAbsolute(hostEnv.XDG_CACHE_HOME)
      ? hostEnv.XDG_CACHE_HOME
      : hostEnv.HOME && isAbsolute(hostEnv.HOME)
        ? join(hostEnv.HOME, ".cache")
        : undefined;
  return cache ? join(cache, "synara", STATE_DIRECTORY_NAME) : undefined;
}

/** A fresh session id; unique across servers and across restarts of this one. */
export function newNestedSessionId(serverPid: number = process.pid): string {
  return `${serverPid}-${randomBytes(4).toString("hex")}`;
}

/**
 * Creates (if needed) and verifies the private state directory, and returns
 * it. Refuses rather than repairs a directory someone else could have written
 * into: markers found there would be instructions from a stranger.
 */
export async function prepareNestedStateDirectory(
  dependencies: NestedSessionRegistryDependencies = {},
): Promise<string> {
  const directory = resolveStateDirectory(dependencies);
  if (!directory) {
    throw new ComputerBackendError(
      "The agent's isolated desktop needs a private directory for its sockets, and this server " +
        "has neither XDG_RUNTIME_DIR nor a home directory. Start Synara from a user session.",
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const problem = await privateDirectoryProblem(directory, resolveUid(dependencies));
  if (problem) {
    throw new ComputerBackendError(
      `The agent's isolated desktop will not use ${directory}: it ${problem}. ` +
        "Remove it and try again.",
    );
  }
  return directory;
}

/**
 * Creates one session's private runtime directory inside the state directory.
 * `mkdir` without `recursive` fails on anything already there, so the session
 * never adopts a directory — or a symlink — it did not create.
 */
export async function createNestedSessionDirectory(
  stateDirectory: string,
  sessionId: string,
  dependencies: Pick<NestedSessionRegistryDependencies, "uid"> = {},
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ComputerBackendError(`Invalid nested session id: ${sessionId}.`);
  }
  const directory = join(stateDirectory, sessionId);
  await mkdir(directory, { mode: 0o700 });
  const problem = await privateDirectoryProblem(directory, resolveUid(dependencies));
  if (problem) {
    throw new ComputerBackendError(`The nested session directory ${directory} ${problem}.`);
  }
  return directory;
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

/**
 * What a marker records about one live process, read back from the kernel
 * rather than from the argv this server passed: that is the form a later sweep
 * compares against, and an unreadable process is recorded as nothing at all.
 */
export function describeNestedSessionProcess(
  pid: number | undefined,
  role: NestedSessionProcessRole,
  dependencies: Pick<NestedSessionRegistryDependencies, "processCommand" | "processStartTime"> = {},
): NestedSessionProcess | undefined {
  if (pid === undefined) return undefined;
  const command = (dependencies.processCommand ?? readProcessCommand)(pid);
  const startTime = (dependencies.processStartTime ?? readProcessStartTime)(pid);
  if (!command || startTime === undefined) return undefined;
  return { pid, command, startTime, role };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** The running server as a marker records it and a sweep recognises it. */
export function currentServerIdentity(
  dependencies: Pick<
    NestedSessionRegistryDependencies,
    "serverPid" | "serverStartTime" | "processStartTime"
  > = {},
): { readonly serverPid: number; readonly serverStartTime: string | undefined } {
  const serverPid = dependencies.serverPid ?? process.pid;
  const serverStartTime =
    "serverStartTime" in dependencies
      ? dependencies.serverStartTime
      : (dependencies.processStartTime ?? readProcessStartTime)(serverPid);
  return { serverPid, serverStartTime };
}

/**
 * Records a running session, so a server that never gets to dispose it still
 * leaves something behind that names what to kill.
 *
 * Rewritten every time the session gains a process, starting with the first
 * one, and deleted on dispose — so the window in which a marker exists covers
 * the whole window in which processes exist that nothing else would reap,
 * boot included. Written through a rename, so a crash mid-write leaves the
 * previous version rather than a truncated one.
 */
export async function writeNestedSessionMarker(
  marker: NestedSessionMarker,
  dependencies: NestedSessionRegistryDependencies = {},
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(marker.sessionId)) {
    throw new ComputerBackendError(`Invalid nested session id: ${marker.sessionId}.`);
  }
  const directory = await prepareNestedStateDirectory(dependencies);
  const path = join(directory, `${marker.sessionId}${MARKER_SUFFIX}`);
  const staging = join(directory, `.${marker.sessionId}${MARKER_SUFFIX}.tmp`);
  await writeFile(staging, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
  await rename(staging, path);
  return path;
}

export async function removeNestedSessionMarker(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Ends every nested session whose server is gone, and returns the ids of the
 * sessions it reaped.
 *
 * Best effort by contract: this runs when a backend is built and on the path
 * to booting a desktop, and a host whose `/proc` cannot be read, or whose
 * stale compositor refuses to die, must not be a host that cannot start a new
 * desktop. Anything it cannot prove is left alone rather than signalled on a
 * guess, and it never creates the directory it sweeps.
 */
export async function reapStaleNestedSessions(
  dependencies: NestedSessionRegistryDependencies = {},
): Promise<readonly string[]> {
  const directory = resolveStateDirectory(dependencies);
  if (!directory) return [];
  const uid = resolveUid(dependencies);
  if (await privateDirectoryProblem(directory, uid)) return [];
  const entries = await readdir(directory).catch(() => [] as string[]);
  const reaped: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(MARKER_SUFFIX) || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    const marker = await readMarker(path, uid);
    if (!marker) {
      // Unreadable, truncated, or not ours: there is nothing here to act on,
      // and leaving it would make every later sweep re-read it forever.
      await removeNestedSessionMarker(path);
      continue;
    }
    if (ownerIsLive(marker, dependencies)) continue;
    for (const recorded of marker.processes) {
      await terminateStaleProcess(recorded, dependencies);
    }
    if (await isOwnSessionDirectory(directory, marker, uid)) {
      await rm(marker.runtimeDirectory!, { recursive: true, force: true }).catch(() => undefined);
    }
    await removeNestedSessionMarker(path);
    reaped.push(marker.sessionId);
  }
  return reaped;
}

/**
 * A live owner is the whole reason to leave a session alone, and this server
 * is its own most important live owner. Both halves of the identity are
 * compared whenever the marker has both.
 */
function ownerIsLive(
  marker: NestedSessionMarker,
  dependencies: NestedSessionRegistryDependencies,
): boolean {
  const own = currentServerIdentity(dependencies);
  const readStartTime = dependencies.processStartTime ?? readProcessStartTime;
  if (marker.serverPid === own.serverPid) {
    return (
      marker.serverStartTime === undefined ||
      own.serverStartTime === undefined ||
      marker.serverStartTime === own.serverStartTime
    );
  }
  const alive = dependencies.processAlive ?? isProcessAlive;
  if (!alive(marker.serverPid)) return false;
  return (
    marker.serverStartTime === undefined ||
    readStartTime(marker.serverPid) === marker.serverStartTime
  );
}

async function terminateStaleProcess(
  recorded: NestedSessionProcess,
  dependencies: NestedSessionRegistryDependencies,
): Promise<void> {
  const alive = dependencies.processAlive ?? isProcessAlive;
  const readCommand = dependencies.processCommand ?? readProcessCommand;
  const readStartTime = dependencies.processStartTime ?? readProcessStartTime;
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 1 || !alive(recorded.pid)) return;
  if (!recordedExecutableAllowed(recorded)) return;
  // Both halves of the identity, because either alone can be coincidence: argv
  // is generic for a private bus daemon, and a pid is a number the OS reuses.
  if (readCommand(recorded.pid) !== recorded.command) return;
  if (readStartTime(recorded.pid) !== recorded.startTime) return;
  const teardown = dependencies.teardownProcessTree ?? teardownProviderProcessTree;
  await teardown({
    rootPid: recorded.pid,
    rootExited: waitForPidExit(recorded.pid, dependencies),
  }).catch(() => undefined);
}

/** A helper role must be the executable that plays it; an app is any recorded launch. */
function recordedExecutableAllowed(recorded: NestedSessionProcess): boolean {
  if (recorded.role === "app") return true;
  const executable = recorded.command.split(" ")[0] ?? "";
  return basename(executable) === ROLE_EXECUTABLES[recorded.role];
}

/** Only a directory this module would have created, still owned by this user. */
async function isOwnSessionDirectory(
  stateDirectory: string,
  marker: NestedSessionMarker,
  uid: number | undefined,
): Promise<boolean> {
  const runtime = marker.runtimeDirectory;
  if (!runtime || !isAbsolute(runtime)) return false;
  if (dirname(runtime) !== stateDirectory || basename(runtime) !== marker.sessionId) return false;
  try {
    const stats = await lstat(runtime);
    return stats.isDirectory() && (uid === undefined || stats.uid === uid);
  } catch {
    return false;
  }
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

async function readMarker(
  path: string,
  uid: number | undefined,
): Promise<NestedSessionMarker | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) return undefined;
    // The name, not the content, says which session this is: it is what the
    // session directory the sweep may delete has to be called.
    const sessionId = basename(path, MARKER_SUFFIX);
    if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<NestedSessionMarker>;
    if (typeof candidate.serverPid !== "number" || !Array.isArray(candidate.processes)) {
      return undefined;
    }
    return {
      serverPid: candidate.serverPid,
      serverStartTime:
        typeof candidate.serverStartTime === "string" ? candidate.serverStartTime : undefined,
      sessionId,
      startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : 0,
      waylandDisplay:
        typeof candidate.waylandDisplay === "string" ? candidate.waylandDisplay : "unknown",
      processes: candidate.processes.filter(isRecordedProcess),
      ...(typeof candidate.runtimeDirectory === "string"
        ? { runtimeDirectory: candidate.runtimeDirectory }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** A process entry with the full identity; anything less is never signalled. */
function isRecordedProcess(entry: unknown): entry is NestedSessionProcess {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as Partial<NestedSessionProcess>;
  return (
    typeof candidate.pid === "number" &&
    typeof candidate.command === "string" &&
    typeof candidate.startTime === "string" &&
    (candidate.role === "app" ||
      (typeof candidate.role === "string" && Object.hasOwn(ROLE_EXECUTABLES, candidate.role)))
  );
}

/**
 * Why a directory is not private to `uid`, or `undefined` when it is: it has
 * to be a real directory (not a symlink to one), owned by this user, with no
 * access for anyone else.
 */
async function privateDirectoryProblem(
  directory: string,
  uid: number | undefined,
): Promise<string | undefined> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    return "does not exist";
  }
  if (stats.isSymbolicLink()) return "is a symbolic link";
  if (!stats.isDirectory()) return "is not a directory";
  if (uid !== undefined && stats.uid !== uid) return `is owned by uid ${stats.uid}`;
  if ((stats.mode & 0o777) !== 0o700) {
    return `has mode ${(stats.mode & 0o777).toString(8)} instead of 700`;
  }
  return undefined;
}

function resolveStateDirectory(
  dependencies: NestedSessionRegistryDependencies,
): string | undefined {
  return dependencies.stateDirectory ?? nestedSessionStateDirectory(dependencies.hostEnv);
}

function resolveUid(
  dependencies: Pick<NestedSessionRegistryDependencies, "uid">,
): number | undefined {
  return dependencies.uid ?? process.getuid?.();
}

/** The direct children of a pid, from the kernel's own list; empty if unreadable. */
export function readChildPids(pid: number | undefined): readonly number[] {
  if (pid === undefined) return [];
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter((entry) => entry.length > 0)
      .map(Number)
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
}
