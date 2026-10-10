const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface SqliteMemoryBudget {
  /** negative KiB, i.e. `-(bytes / 1024)` */
  readonly cacheSizePragma: number;
  /** `PRAGMA mmap_size` in bytes */
  readonly mmapSizeBytes: number;
}

/** the event log can exceed a GB so the 2MB default cache thrashes during replay — but mmap pages and heap cache compete with the renderer and provider CLIs: on an 8GB laptop the same ceilings push the machine into swap during startup; scale with what the host has */
export function resolveSqliteMemoryBudget(totalMemoryBytes: number): SqliteMemoryBudget {
  const total = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes : 0;
  if (total >= 24 * GIB) {
    return { cacheSizePragma: -(256 * MIB) / 1024, mmapSizeBytes: 1 * GIB };
  }
  if (total >= 12 * GIB) {
    return { cacheSizePragma: -(128 * MIB) / 1024, mmapSizeBytes: 512 * MIB };
  }
  return { cacheSizePragma: -(64 * MIB) / 1024, mmapSizeBytes: 256 * MIB };
}
