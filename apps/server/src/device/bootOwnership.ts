/** tracks Synara-booted simulators across process death: a crash runs no finalizer and the orphan reappears as "user"-booted, outside every reclaim path; plain JSON because it must work before the server exists and must degrade to "own nothing"; only reclaimed when still booted AND still ours */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** written atomically so a mid-write crash cannot leave an unparsable file */
interface BootOwnershipFile {
  readonly version: 1;
  /** which process wrote this, so a live sibling's devices are left alone */
  readonly pid: number;
  readonly udids: readonly string[];
}

export interface BootOwnershipStore {
  read(): Promise<{ readonly pid: number; readonly udids: readonly string[] } | null>;
  write(udids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/** a store that remembers nothing, for tests and unsupported platforms */
export const NULL_BOOT_OWNERSHIP: BootOwnershipStore = {
  read: async () => null,
  write: async () => undefined,
  clear: async () => undefined,
};

export function makeBootOwnershipStore(
  filePath: string,
  processId: number = process.pid,
): BootOwnershipStore {
  const writeFileAtomically = async (contents: string): Promise<void> => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${processId}.tmp`;
    await writeFile(temporaryPath, contents, "utf8");
    // rename is atomic — a reader sees the old file or the new one, never half-written
    await rename(temporaryPath, filePath);
  };

  return {
    async read() {
      const raw = await readFile(filePath, "utf8").catch(() => null);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<BootOwnershipFile>;
        if (parsed.version !== 1 || !Array.isArray(parsed.udids)) return null;
        const udids = parsed.udids.filter((udid): udid is string => typeof udid === "string");
        return { pid: typeof parsed.pid === "number" ? parsed.pid : 0, udids };
      } catch {
        // unparsable means we cannot prove ownership — killing a device we don't own is worse than leaking one
        return null;
      }
    },

    async write(udids) {
      const file: BootOwnershipFile = { version: 1, pid: processId, udids: [...udids] };
      await writeFileAtomically(JSON.stringify(file)).catch(() => undefined);
    },

    async clear() {
      await writeFileAtomically(
        JSON.stringify({ version: 1, pid: processId, udids: [] } satisfies BootOwnershipFile),
      ).catch(() => undefined);
    },
  };
}

/** only devices still booted AND recorded by a dead process — a live sibling's record belongs to it */
export function orphanedBootUdids(
  recorded: { readonly pid: number; readonly udids: readonly string[] } | null,
  bootedUdids: readonly string[],
  isProcessAlive: (pid: number) => boolean,
): readonly string[] {
  if (recorded === null || recorded.udids.length === 0) return [];
  if (recorded.pid > 0 && isProcessAlive(recorded.pid)) return [];
  const booted = new Set(bootedUdids);
  return recorded.udids.filter((udid) => booted.has(udid));
}

export function processIsAlive(pid: number): boolean {
  try {
    // signal 0 performs the existence check without delivering; EPERM still counts as alive
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
