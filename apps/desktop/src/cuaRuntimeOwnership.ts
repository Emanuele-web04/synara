import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const MARKER_NAME = ".synara-cua-runtime.json";
const RUNTIME_DIRECTORY = /^synara-cua-[a-zA-Z0-9]{6}$/;
const STALE_AFTER_MS = 30_000;

export function cuaHostProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and other probe errors are not proof that the owner died.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function markCuaRuntimeDirectory(directory: string): Promise<void> {
  await writeFile(
    join(directory, MARKER_NAME),
    JSON.stringify({
      schema: "synara-cua-runtime",
      version: 1,
      directory: basename(directory),
      hostPid: process.pid,
      ownerUid: process.getuid?.() ?? null,
      createdAt: Date.now(),
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}

/** Only explicit private runtime ownership permits recursive cleanup. Similar
 * prefixes, legacy unmarked directories, and a lazy live host are preserved. */
export function sweepOwnedCuaRuntimeDirectories(options: {
  directory: string;
  liveSocketDirs: ReadonlySet<string>;
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
}): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const now = options.now ?? Date.now();
  const isProcessAlive = options.isProcessAlive ?? cuaHostProcessIsAlive;
  const protectedDirectories = new Set<string>();
  for (const path of options.liveSocketDirs) {
    try {
      protectedDirectories.add(realpathSync(path));
    } catch {
      protectedDirectories.add(path);
    }
  }
  let entries: string[];
  try {
    entries = readdirSync(options.directory);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!RUNTIME_DIRECTORY.test(entry)) continue;
    const directory = join(options.directory, entry);
    let markerFd: number | undefined;
    try {
      const before = lstatSync(directory);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        before.uid !== uid ||
        (before.mode & 0o077) !== 0 ||
        now - before.mtimeMs < STALE_AFTER_MS ||
        protectedDirectories.has(realpathSync(directory))
      )
        continue;
      markerFd = openSync(
        join(directory, MARKER_NAME),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const markerStat = fstatSync(markerFd);
      if (
        !markerStat.isFile() ||
        markerStat.uid !== uid ||
        markerStat.nlink !== 1 ||
        (markerStat.mode & 0o077) !== 0 ||
        markerStat.size <= 0 ||
        markerStat.size > 1_024
      )
        continue;
      const bytes = Buffer.alloc(1_025);
      const length = readSync(markerFd, bytes, 0, bytes.length, 0);
      if (length === 0 || length > 1_024) continue;
      const marker: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) continue;
      const data = marker as Record<string, unknown>;
      if (
        data.schema !== "synara-cua-runtime" ||
        data.version !== 1 ||
        data.directory !== entry ||
        data.ownerUid !== uid ||
        typeof data.hostPid !== "number" ||
        !Number.isSafeInteger(data.hostPid) ||
        data.hostPid <= 0 ||
        data.hostPid > 0x7fffffff ||
        typeof data.createdAt !== "number" ||
        !Number.isFinite(data.createdAt) ||
        data.createdAt <= 0 ||
        now - data.createdAt < STALE_AFTER_MS ||
        isProcessAlive(data.hostPid)
      )
        continue;
      // Refuse replacement/symlink races between the ownership read and removal.
      const after = lstatSync(directory);
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.uid !== uid ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        (after.mode & 0o077) !== 0
      )
        continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Missing, malformed, unreadable, or changed ownership is not permission
      // to delete. A future sweep can reconsider a still-owned stale runtime.
    } finally {
      if (markerFd !== undefined) closeSync(markerFd);
    }
  }
  return removed;
}
