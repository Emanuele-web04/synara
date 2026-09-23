/** Resource-only process snapshots: comm is an executable name, never argv. */
export interface ResourceProcess {
  readonly pid: number;
  readonly parentPid: number;
  /** C-locale ps lstart, with one-second precision. */
  readonly startedAt: string;
  readonly executable: string;
  readonly rssKiB: number;
  readonly cpuPercent: number;
  readonly lifetimeCpuSeconds: number;
}

export function parseLifetimeCpuSeconds(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error("Invalid ps CPU time.");
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (
    seconds >= 60 ||
    (match[2] !== undefined && minutes >= 60) ||
    (match[1] !== undefined && (match[2] === undefined || hours >= 24))
  ) {
    throw new Error("Invalid ps CPU time.");
  }
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  if (!Number.isFinite(total)) throw new Error("Invalid ps CPU time.");
  return total;
}

/** Parse only the fixed pid,ppid,lstart,rss,%cpu,time,comm columns. */
export function parseResourceSnapshot(output: string): ResourceProcess[] {
  const rows: ResourceProcess[] = [];
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match =
      /^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\S+)\s+(.+?)\s*$/.exec(
        line,
      );
    if (!match) throw new Error("Malformed resource snapshot; no raw process data was retained.");
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rssKiB = Number(match[4]);
    const cpuPercent = Number(match[5]);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(rssKiB) ||
      !Number.isFinite(cpuPercent) ||
      pids.has(pid)
    ) {
      throw new Error("Invalid or duplicate process identity in resource snapshot.");
    }
    pids.add(pid);
    rows.push({
      pid,
      parentPid,
      startedAt: match[3]!.replace(/\s+/g, " "),
      executable: match[7]!,
      rssKiB,
      cpuPercent,
      lifetimeCpuSeconds: parseLifetimeCpuSeconds(match[6]!),
    });
  }
  return rows;
}

export function resourceIdentity(process: Pick<ResourceProcess, "pid" | "startedAt">): string {
  return `${process.pid}:${process.startedAt}`;
}

export interface OwnedResourceSnapshot {
  readonly rootState: "running" | "missing" | "replaced";
  readonly processes: ResourceProcess[];
}

/**
 * Retain observed descendants after reparenting, but never follow a reused PID
 * as the original process. Newly spawned children must have a currently owned
 * parent in this snapshot. Missing ancestors cannot prove unseen descendants.
 */
export function makeResourceTracker(root: ResourceProcess) {
  let owned = new Map<number, string>([[root.pid, root.startedAt]]);
  return (rows: readonly ResourceProcess[]): OwnedResourceSnapshot => {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const currentRoot = byPid.get(root.pid);
    const rootState = !currentRoot
      ? "missing"
      : currentRoot.startedAt === root.startedAt && currentRoot.executable === root.executable
        ? "running"
        : "replaced";
    const children = new Map<number, ResourceProcess[]>();
    for (const row of rows) {
      const siblings = children.get(row.parentPid) ?? [];
      siblings.push(row);
      children.set(row.parentPid, siblings);
    }
    const pending: ResourceProcess[] = [];
    for (const [pid, startedAt] of owned) {
      const row = byPid.get(pid);
      if (row?.startedAt === startedAt && (pid !== root.pid || rootState === "running")) {
        pending.push(row);
      }
    }
    const selected = new Map<number, ResourceProcess>();
    for (let index = 0; index < pending.length; index += 1) {
      const row = pending[index]!;
      if (selected.has(row.pid)) continue;
      selected.set(row.pid, row);
      for (const child of children.get(row.pid) ?? []) {
        // A replacement of the explicitly selected root is never in scope,
        // even if the process table now happens to link it under an old child.
        if (child.pid !== root.pid || rootState === "running") pending.push(child);
      }
    }
    owned = new Map([...selected].map(([pid, row]) => [pid, row.startedAt]));
    return { rootState, processes: [...selected.values()].sort((a, b) => a.pid - b.pid) };
  };
}

export interface ResourceSamplingOptions {
  readonly rootPid: number;
  readonly durationMs: number;
  readonly intervalMs: number;
}

export function resourceSamplingOptions(input: {
  readonly pid?: string | undefined;
  readonly seconds?: string | undefined;
  readonly intervalMs?: string | undefined;
}): ResourceSamplingOptions {
  const integer = (value: string | undefined, fallback?: number): number =>
    value === undefined && fallback !== undefined
      ? fallback
      : value !== undefined && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  const rootPid = integer(input.pid);
  const seconds = integer(input.seconds, 120);
  const intervalMs = integer(input.intervalMs, 1_000);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootPid > 0x7fffffff) {
    throw new Error("Use one explicit root PID greater than 1.");
  }
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) {
    throw new Error("Duration must be 1–600 seconds.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 5_000) {
    throw new Error("Interval must be 500–5000 milliseconds.");
  }
  return { rootPid, durationMs: seconds * 1_000, intervalMs };
}
