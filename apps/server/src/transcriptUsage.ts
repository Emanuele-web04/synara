// FILE: transcriptUsage.ts
// Purpose: Reads the usage and turns Claude Code and Codex keep in their own session
// files (~/.claude/projects, ~/.codex/sessions) for Usage → Analytics' "This Mac"
// scope, with a per-file cache: unchanged files are not opened again and grown
// files are read from where the last read stopped.
// Layer: server usage reading (node:fs). Parsing lives in transcriptUsageParsers.ts.

import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";

import { mapWithConcurrency, resolveClaudeProjectsRoot } from "./providerUsageSnapshot";
import {
  claudeLineMightMatter,
  codexLineMightMatter,
  type CodexTranscriptState,
  initialCodexTranscriptState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  type TranscriptProvider,
  type TranscriptRecord,
} from "./transcriptUsageParsers";

const FILE_READ_CONCURRENCY = 8;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
// A longer line is skipped. Usage and prompt lines are small; giant lines are
// tool output.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// Bytes before the resume point that must still match for a grown file to be
// read from there; a rotated or rewritten file changes them.
const GUARD_BYTES = 64;
// Records kept across reads. Past this, older files are read again on the next
// request, which costs time, never correctness.
const MAX_CACHED_RECORDS = 400_000;

export interface TranscriptRoot {
  readonly provider: TranscriptProvider;
  readonly path: string;
}

/** Claude Code's projects folder and Codex's session folders under this home. */
export function defaultTranscriptRoots(homeDir: string): ReadonlyArray<TranscriptRoot> {
  const codexHome = process.env.CODEX_HOME?.trim() || nodePath.join(homeDir, ".codex");
  return [
    { provider: "claudeAgent", path: resolveClaudeProjectsRoot(homeDir) },
    { provider: "codex", path: nodePath.join(codexHome, "sessions") },
    { provider: "codex", path: nodePath.join(codexHome, "archived_sessions") },
  ];
}

interface TranscriptFile {
  readonly provider: TranscriptProvider;
  readonly path: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedTranscript {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** Just past the last newline read; a grown file resumes here. */
  readonly offset: number;
  readonly guardHash: number;
  readonly guardLength: number;
  readonly codexState: CodexTranscriptState | null;
  readonly records: ReadonlyArray<TranscriptRecord>;
  /** Records from a last line without its newline yet; read again next time. */
  readonly tailRecords: ReadonlyArray<TranscriptRecord>;
}

export interface TranscriptScan {
  /** Providers whose session folder exists on this Mac. */
  readonly providers: ReadonlySet<TranscriptProvider>;
  /** Records per file, in path order, not yet de-duplicated across files. */
  readonly files: ReadonlyArray<ReadonlyArray<TranscriptRecord>>;
}

export interface TranscriptUsageReader {
  /** Records from every session file written at or after `sinceMs`. */
  readonly scan: (sinceMs: number) => Promise<TranscriptScan>;
}

function fnv1a(bytes: Buffer): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function readDirectory(path: string): Promise<ReadonlyArray<Dirent> | null> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Every `.jsonl` under `root`, subagent folders included. Null when `root` is missing. */
async function listJsonlFiles(root: string): Promise<ReadonlyArray<string> | null> {
  const top = await readDirectory(root);
  if (top === null) return null;
  const found: string[] = [];
  const walk = async (directory: string, entries: ReadonlyArray<Dirent>) => {
    for (const entry of entries) {
      const child = nodePath.join(directory, entry.name);
      // Symlinks are not followed, so a link cannot loop the walk.
      if (entry.isDirectory()) {
        const nested = await readDirectory(child);
        if (nested) await walk(child, nested);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(child);
      }
    }
  };
  await walk(root, top);
  return found;
}

function intern(pool: Map<string, string>, value: string): string {
  const existing = pool.get(value);
  if (existing !== undefined) return existing;
  pool.set(value, value);
  return value;
}

/**
 * Reads one session file from where the cached read stopped (or from the start),
 * streaming so a multi-hundred-megabyte session never sits in memory whole.
 * Returns null when the file cannot be read, which is not cached.
 */
async function readTranscript(
  file: TranscriptFile,
  base: CachedTranscript | null,
  strings: Map<string, string>,
): Promise<CachedTranscript | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file.path, "r");
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    let resumeFrom: CachedTranscript | null = null;
    if (base && base.ino === stats.ino && stats.size >= base.offset && base.guardLength > 0) {
      const guard = Buffer.alloc(base.guardLength);
      const { bytesRead } = await handle.read(
        guard,
        0,
        base.guardLength,
        base.offset - base.guardLength,
      );
      if (bytesRead === base.guardLength && fnv1a(guard) === base.guardHash) resumeFrom = base;
    }

    const codexState: CodexTranscriptState | null =
      file.provider === "codex"
        ? resumeFrom?.codexState
          ? { ...resumeFrom.codexState }
          : initialCodexTranscriptState()
        : null;
    const start = resumeFrom?.offset ?? 0;
    const records: TranscriptRecord[] = [];
    const tailRecords: TranscriptRecord[] = [];

    const parse = (line: Buffer, state: CodexTranscriptState | null) => {
      const content =
        line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
      if (state === null) {
        return claudeLineMightMatter(content)
          ? parseClaudeTranscriptLine(content.toString("utf8"))
          : null;
      }
      return codexLineMightMatter(content)
        ? parseCodexTranscriptLine(content.toString("utf8"), state)
        : null;
    };
    const keep = (parsed: TranscriptRecord | null, into: TranscriptRecord[]) => {
      if (parsed === null) return;
      into.push({
        ...parsed,
        model: intern(strings, parsed.model),
        cwd: intern(strings, parsed.cwd),
      });
    };

    let chunks: Buffer[] = [];
    let pendingBytes = 0;
    let skippingLongLine = false;
    let offset = start;
    let position = start;
    const append = (segment: Buffer) => {
      if (skippingLongLine || segment.length === 0) return;
      if (pendingBytes + segment.length > MAX_LINE_BYTES) {
        chunks = [];
        pendingBytes = 0;
        skippingLongLine = true;
        return;
      }
      chunks.push(segment);
      pendingBytes += segment.length;
    };
    const takePending = (): Buffer | null => {
      const line =
        skippingLongLine || pendingBytes === 0
          ? null
          : chunks.length === 1
            ? chunks[0]!
            : Buffer.concat(chunks, pendingBytes);
      chunks = [];
      pendingBytes = 0;
      skippingLongLine = false;
      return line;
    };

    if (stats.size > start) {
      // A stream of its own: a FileHandle stream closes the handle when it ends,
      // and the guard below still reads from it.
      const stream = createReadStream(file.path, { start, highWaterMark: 256 * 1024 });
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          let lineStart = 0;
          for (
            let newline = chunk.indexOf(NEWLINE);
            newline !== -1;
            newline = chunk.indexOf(NEWLINE, lineStart)
          ) {
            if (pendingBytes === 0 && !skippingLongLine) {
              keep(parse(chunk.subarray(lineStart, newline), codexState), records);
            } else {
              append(chunk.subarray(lineStart, newline));
              const line = takePending();
              if (line) keep(parse(line, codexState), records);
            }
            lineStart = newline + 1;
            offset = position + lineStart;
          }
          append(chunk.subarray(lineStart));
          position += chunk.length;
        }
      } finally {
        stream.destroy();
      }
      // A last line without its newline counts now but is read again later,
      // with a copy of the state so the committed state stays at `offset`.
      const tail = takePending();
      if (tail) keep(parse(tail, codexState ? { ...codexState } : null), tailRecords);
    }

    const guardLength = Math.min(GUARD_BYTES, offset);
    let guardHash = 0;
    if (guardLength > 0) {
      const guard = Buffer.alloc(guardLength);
      await handle.read(guard, 0, guardLength, offset - guardLength);
      guardHash = fnv1a(guard);
    }
    return {
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      offset,
      guardHash,
      guardLength,
      codexState,
      records: resumeFrom ? resumeFrom.records.concat(records) : records,
      tailRecords,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function recordsOf(entry: CachedTranscript): ReadonlyArray<TranscriptRecord> {
  return entry.tailRecords.length === 0 ? entry.records : entry.records.concat(entry.tailRecords);
}

export function makeTranscriptUsageReader(
  roots: ReadonlyArray<TranscriptRoot>,
): TranscriptUsageReader {
  const cache = new Map<string, CachedTranscript>();
  const strings = new Map<string, string>();

  const listFiles = async () => {
    const providers = new Set<TranscriptProvider>();
    const paths: Array<{ provider: TranscriptProvider; path: string }> = [];
    for (const root of roots) {
      const found = await listJsonlFiles(root.path);
      if (found === null) continue;
      providers.add(root.provider);
      for (const path of found) paths.push({ provider: root.provider, path });
    }
    const files = await mapWithConcurrency(paths, 32, async (entry) => {
      try {
        const stats = await fs.stat(entry.path);
        return { ...entry, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        return null;
      }
    });
    return {
      providers,
      files: files
        .filter((file): file is TranscriptFile => file !== null)
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  };

  const readCached = async (file: TranscriptFile) => {
    const cached = cache.get(file.path) ?? null;
    if (
      cached &&
      cached.ino === file.ino &&
      cached.size === file.size &&
      cached.mtimeMs === file.mtimeMs
    ) {
      return recordsOf(cached);
    }
    const entry = await readTranscript(file, cached, strings);
    if (entry === null) {
      cache.delete(file.path);
      return [];
    }
    cache.set(file.path, entry);
    return recordsOf(entry);
  };

  /** Drops deleted files, then keeps the newest files up to the record cap. */
  const prune = (files: ReadonlyArray<TranscriptFile>) => {
    const kept = new Set<string>();
    let total = 0;
    for (const file of files.toSorted((left, right) => right.mtimeMs - left.mtimeMs)) {
      const entry = cache.get(file.path);
      if (!entry) continue;
      const size = entry.records.length + entry.tailRecords.length;
      if (total + size > MAX_CACHED_RECORDS) continue;
      total += size;
      kept.add(file.path);
    }
    for (const path of cache.keys()) if (!kept.has(path)) cache.delete(path);
    if (cache.size === 0) strings.clear();
  };

  // One scan at a time, so overlapping requests share the cache instead of
  // reading the same files twice.
  let pending: Promise<unknown> = Promise.resolve();
  const scan = (sinceMs: number): Promise<TranscriptScan> => {
    const run = pending.then(async () => {
      const { providers, files } = await listFiles();
      const inWindow = files.filter((file) => file.mtimeMs >= sinceMs);
      const perFile = await mapWithConcurrency(inWindow, FILE_READ_CONCURRENCY, readCached);
      prune(files);
      return { providers, files: perFile };
    });
    pending = run.catch(() => undefined);
    return run;
  };

  return { scan };
}
