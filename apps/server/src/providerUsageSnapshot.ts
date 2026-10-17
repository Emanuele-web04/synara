// FILE: providerUsageSnapshot.ts
// Purpose: Read provider-specific local usage archives for recent usage snapshots.

import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";

import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "./config";

const LOOKBACK_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS;
const LOOKBACK_30D_MS = LOOKBACK_DAYS * ONE_DAY_MS;
const USAGE_CACHE_TTL_MS = 30_000;
// Keep enough recent archives to make the 30d summary materially different from 7d
// for heavy local usage without scanning the full historical archive every refresh.
const MAX_RECENT_USAGE_FILES = 2_000;
const PROVIDER_USAGE_FILE_READ_CONCURRENCY = 16;
const CODEX_SESSION_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CODEX_SESSION_LINE_BYTES = 1024 * 1024;
const MAX_CLAUDE_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
// Usage samples kept across refreshes in the per-transcript cache. A sample plus its
// dedupe key costs roughly 200 bytes, so this bounds the cache near 20 MB. Newest
// transcripts are retained first; transcripts past the cap are re-read on every
// refresh instead of retained, which only costs time, never correctness.
const MAX_CACHED_CLAUDE_USAGE_SAMPLES = 100_000;

type UsageSnapshot = Exclude<ServerGetProviderUsageSnapshotResult, null>;

interface CachedUsageSnapshot {
  expiresAtMs: number;
  value: ServerGetProviderUsageSnapshotResult;
  pending: Promise<ServerGetProviderUsageSnapshotResult> | null;
}

interface CodexSessionSummary {
  timestampMs: number;
  totalTokens: number;
  limits: ReadonlyArray<ServerProviderUsageLimit>;
}

interface ClaudeUsageSample {
  sessionId: string;
  timestampMs: number;
  totalTokens: number;
  model: string | null;
}

interface ClaudeTranscriptFile {
  readonly path: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * What one transcript contributed on its last read. `offset` sits just past the last
 * newline that was parsed, so a later read resumes there when the transcript has only
 * grown. A final record without its newline yet is parsed into `tailSamples` for the
 * current snapshot but not committed, and is read again once it is complete.
 */
interface ClaudeTranscriptCacheEntry {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly offset: number;
  readonly lineCount: number;
  readonly samples: ReadonlyArray<ClaudeUsageSample>;
  readonly tailSamples: ReadonlyArray<ClaudeUsageSample>;
  readonly seenKeys: ReadonlySet<string>;
}

const usageSnapshotCache = new Map<string, CachedUsageSnapshot>();
// Entries are replaced, never mutated, so overlapping refreshes cannot corrupt them.
const claudeTranscriptCache = new Map<string, ClaudeTranscriptCacheEntry>();
const EMPTY_KEYS: ReadonlySet<string> = new Set();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatCompactNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: absoluteValue < 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatTokenValue(tokens: number): string {
  return `${formatCompactNumber(tokens)} tokens`;
}

function formatRecentSessionsSubtitle(sessionCount: number): string | undefined {
  if (sessionCount <= 0) {
    return undefined;
  }
  return `${new Intl.NumberFormat(undefined).format(sessionCount)} recent ${sessionCount === 1 ? "session" : "sessions"}`;
}

async function safeReadDir(path: string): Promise<ReadonlyArray<Dirent>> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

// Bounds archive reads so a cold stats load does useful parallel work without
// flooding the filesystem with thousands of simultaneous readFile calls.
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item === undefined) {
          continue;
        }
        results.push({ index, value: await mapper(item) });
      }
    }),
  );

  return results.toSorted((left, right) => left.index - right.index).map((entry) => entry.value);
}

async function listRecentFiles(
  paths: ReadonlyArray<string>,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<ReadonlyArray<string>> {
  const filesWithStats = await mapWithConcurrency(
    paths,
    PROVIDER_USAGE_FILE_READ_CONCURRENCY,
    async (path) => ({
      path,
      mtimeMs: (await safeStat(path))?.mtimeMs ?? 0,
    }),
  );

  return filesWithStats
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

function buildUsageLines(input: {
  tokens24h: number;
  tokens7d: number;
  tokens30d: number;
  sessions24h: number;
  sessions7d: number;
  sessions30d: number;
}): ReadonlyArray<ServerProviderUsageLine> {
  return [
    {
      label: "24h",
      value: formatTokenValue(input.tokens24h),
      ...(formatRecentSessionsSubtitle(input.sessions24h)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions24h) }
        : {}),
    },
    {
      label: "7d",
      value: formatTokenValue(input.tokens7d),
      ...(formatRecentSessionsSubtitle(input.sessions7d)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions7d) }
        : {}),
    },
    {
      label: "30d",
      value: formatTokenValue(input.tokens30d),
      ...(formatRecentSessionsSubtitle(input.sessions30d)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions30d) }
        : {}),
    },
  ];
}

function normalizeCodexUsageLimits(value: unknown): ReadonlyArray<ServerProviderUsageLimit> {
  const rateLimits = asRecord(value);
  if (!rateLimits) {
    return [];
  }

  const parseLimit = (
    label: string,
    source: Record<string, unknown> | null,
  ): ServerProviderUsageLimit | null => {
    if (!source) {
      return null;
    }

    const usedPercent = asNonNegativeNumber(source.used_percent ?? source.usedPercent);
    const windowDurationMins = asNonNegativeNumber(source.window_minutes ?? source.windowMinutes);
    const resetsAt =
      asString(source.resets_at ?? source.resetsAt) ??
      asString(source.next_reset_at ?? source.nextResetAt);
    if (usedPercent === undefined && windowDurationMins === undefined && !resetsAt) {
      return null;
    }

    return {
      window: label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    };
  };

  const primary = parseLimit("5h", asRecord(rateLimits.primary));
  const secondary = parseLimit("Weekly", asRecord(rateLimits.secondary));

  return [primary, secondary].filter((limit): limit is ServerProviderUsageLimit => limit !== null);
}

function readCodexTotalTokens(payload: Record<string, unknown>): number {
  const info = asRecord(payload.info);
  const totalUsage =
    asRecord(info?.total_token_usage) ??
    asRecord(info?.totalTokenUsage) ??
    asRecord(info?.total) ??
    asRecord(payload.total_token_usage) ??
    asRecord(payload.totalTokenUsage) ??
    asRecord(payload.total);

  return (
    asNonNegativeNumber(totalUsage?.total_tokens) ??
    asNonNegativeNumber(totalUsage?.totalTokens) ??
    asNonNegativeNumber(info?.total_tokens) ??
    asNonNegativeNumber(info?.totalTokens) ??
    asNonNegativeNumber(payload.total_tokens) ??
    asNonNegativeNumber(payload.totalTokens) ??
    0
  );
}

async function listRecentCodexSessionFiles(sessionsRoot: string): Promise<ReadonlyArray<string>> {
  const now = new Date();
  const candidates: string[] = [];

  for (let offset = 0; offset <= LOOKBACK_DAYS; offset += 1) {
    const current = new Date(now);
    current.setDate(now.getDate() - offset);
    const dayDir = nodePath.join(
      sessionsRoot,
      `${current.getFullYear()}`,
      `${String(current.getMonth() + 1).padStart(2, "0")}`,
      `${String(current.getDate()).padStart(2, "0")}`,
    );
    const entries = await safeReadDir(dayDir);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push(nodePath.join(dayDir, entry.name));
      }
    }
  }

  return listRecentFiles(candidates);
}

async function readFileRange(
  handle: Awaited<ReturnType<typeof fs.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

function parseCodexSessionSummaryLine(line: string): CodexSessionSummary | null {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record || record.type !== "event_msg") {
    return null;
  }

  const payload = asRecord(record.payload);
  if (!payload || payload.type !== "token_count") {
    return null;
  }

  const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
  if (timestampMs === null) {
    return null;
  }

  return {
    timestampMs,
    totalTokens: readCodexTotalTokens(payload),
    limits: normalizeCodexUsageLimits(payload.rate_limits ?? payload.rateLimits),
  };
}

export async function readCodexSessionSummary(path: string): Promise<CodexSessionSummary | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return null;
  }

  try {
    const { size } = await handle.stat();
    let position = size;
    let partialLine = Buffer.alloc(0);
    let skippingOversizedLine = false;

    while (position > 0) {
      const length = Math.min(CODEX_SESSION_READ_CHUNK_BYTES, position);
      position -= length;
      const bytes = await readFileRange(handle, position, length);
      let lineEnd = bytes.length;

      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 0x0a) {
          continue;
        }

        const linePrefix = bytes.subarray(index + 1, lineEnd);
        if (skippingOversizedLine) {
          skippingOversizedLine = false;
        } else {
          const lineLength = linePrefix.length + partialLine.length;
          if (lineLength <= MAX_CODEX_SESSION_LINE_BYTES) {
            const summary = parseCodexSessionSummaryLine(
              Buffer.concat([linePrefix, partialLine], lineLength).toString("utf8"),
            );
            if (summary) {
              return summary;
            }
          }
        }

        partialLine = Buffer.alloc(0);
        lineEnd = index;
      }

      if (skippingOversizedLine) {
        continue;
      }

      const linePrefix = bytes.subarray(0, lineEnd);
      const lineLength = linePrefix.length + partialLine.length;
      if (lineLength > MAX_CODEX_SESSION_LINE_BYTES) {
        partialLine = Buffer.alloc(0);
        skippingOversizedLine = true;
        continue;
      }
      partialLine = Buffer.concat([linePrefix, partialLine], lineLength);
    }

    return skippingOversizedLine
      ? null
      : parseCodexSessionSummaryLine(partialLine.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function readClaudeTotalTokens(value: unknown): number {
  const usage = asRecord(value);
  if (!usage) {
    return 0;
  }

  const inputTokens =
    (asNonNegativeNumber(usage.input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_read_input_tokens) ?? 0);
  const outputTokens = asNonNegativeNumber(usage.output_tokens) ?? 0;
  return asNonNegativeNumber(usage.total_tokens) ?? inputTokens + outputTokens;
}

function readClaudeAssistantSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  if (input.record.type !== "assistant") {
    return null;
  }

  const message = asRecord(input.record.message);
  const usage = asRecord(message?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const model = asString(message?.model) ?? null;
  const dedupeKey =
    `${sessionId}:assistant:` +
    (asString(input.record.requestId) ??
      asString(message?.id) ??
      asString(input.record.uuid) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model,
    },
  };
}

function readClaudeToolResultSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  const toolUseResult = asRecord(input.record.toolUseResult);
  const usage = asRecord(toolUseResult?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!toolUseResult || !usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const dedupeKey =
    `${sessionId}:tool-result:` +
    (asString(input.record.uuid) ??
      asString(toolUseResult.agentId) ??
      asString(input.record.requestId) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model: null,
    },
  };
}

// Claude Code stores transcripts under `<CLAUDE_CONFIG_DIR>/projects`, defaulting to
// `~/.claude/projects`. Honor the override so the Profile reads the SAME transcripts
// the active Claude provider does (the adapter inherits `process.env`).
function resolveClaudeProjectsRoot(homeDir: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return nodePath.join(configDir || nodePath.join(homeDir, ".claude"), "projects");
}

async function listRecentClaudeTranscriptFiles(
  projectsRoot: string,
  nowMs: number,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<ReadonlyArray<ClaudeTranscriptFile>> {
  const candidates: string[] = [];
  const projectEntries = await safeReadDir(projectsRoot);

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectDir = nodePath.join(projectsRoot, projectEntry.name);
    const transcriptEntries = await safeReadDir(projectDir);
    for (const transcriptEntry of transcriptEntries) {
      if (transcriptEntry.isFile() && transcriptEntry.name.endsWith(".jsonl")) {
        candidates.push(nodePath.join(projectDir, transcriptEntry.name));
      }
    }
  }

  // A transcript last written before the 30d window holds no sample inside it, so it
  // is not opened at all.
  const cutoffMs = nowMs - LOOKBACK_30D_MS;
  const files = await mapWithConcurrency(
    candidates,
    PROVIDER_USAGE_FILE_READ_CONCURRENCY,
    async (path): Promise<ClaudeTranscriptFile | null> => {
      const stats = await safeStat(path);
      return stats && stats.isFile() && stats.mtimeMs >= cutoffMs
        ? { path, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
        : null;
    },
  );

  return files
    .filter((file): file is ClaudeTranscriptFile => file !== null)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles);
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

interface ClaudeTranscriptScan {
  // Samples from newline-terminated records, with the dedupe keys they claimed.
  readonly samples: ClaudeUsageSample[];
  readonly dedupeKeys: ReadonlyArray<string>;
  // Samples from a final record that has no newline yet.
  readonly tailSamples: ClaudeUsageSample[];
  readonly nextOffset: number;
  readonly nextLineIndex: number;
  readonly complete: boolean;
}

/**
 * Claude transcripts are unbounded: a long-running session writes hundreds of megabytes
 * into one file, and a snapshot reads PROVIDER_USAGE_FILE_READ_CONCURRENCY of them at
 * once. Reading one into a string costs its full size in the heap plus a second copy for
 * the line split, so a few large transcripts are enough to exhaust old space and abort the
 * backend. Stream chunks and cap individual records so malformed or tool-heavy lines cannot
 * recreate the same problem inside a line reader.
 *
 * Scans bytes [start, end) and reports the offset just past the last newline, the same
 * append-tail contract as `readAppendedLines` in claudeWorkflowRuntime.ts. That helper
 * reads the whole appended range into one string and skips files over 5 MB, so it cannot
 * serve unbounded transcripts; this streams instead.
 */
async function scanClaudeTranscript(input: {
  readonly handle: FileHandle;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly lineIndex: number;
  readonly seenKeys: ReadonlySet<string>;
}): Promise<ClaudeTranscriptScan> {
  const samples: ClaudeUsageSample[] = [];
  const tailSamples: ClaudeUsageSample[] = [];
  const newKeys = new Set<string>();
  // JSON.parse allocates a fresh copy of every session id and model name; share one.
  const strings = new Map<string, string>();
  const intern = (value: string): string => {
    const existing = strings.get(value);
    if (existing !== undefined) {
      return existing;
    }
    strings.set(value, value);
    return value;
  };
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineIndex = input.lineIndex;
  let nextOffset = input.start;
  let skippingOversizedLine = false;
  let complete = true;

  const collectLine = (line: Buffer, index: number, terminated: boolean): void => {
    if (line.length === 0) {
      return;
    }
    const contents = line.toString("utf8");
    if (!contents.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record) {
      return;
    }

    const fallbackKey = `${input.path}:${index}`;
    for (const candidate of [
      readClaudeAssistantSample({ record, fallbackKey }),
      readClaudeToolResultSample({ record, fallbackKey }),
    ]) {
      if (
        !candidate ||
        input.seenKeys.has(candidate.dedupeKey) ||
        newKeys.has(candidate.dedupeKey)
      ) {
        continue;
      }
      const sample: ClaudeUsageSample = {
        sessionId: intern(candidate.sample.sessionId),
        timestampMs: candidate.sample.timestampMs,
        totalTokens: candidate.sample.totalTokens,
        model: candidate.sample.model === null ? null : intern(candidate.sample.model),
      };
      if (terminated) {
        newKeys.add(candidate.dedupeKey);
        samples.push(sample);
      } else {
        tailSamples.push(sample);
      }
    }
  };

  const appendLineChunk = (chunk: Buffer): void => {
    if (skippingOversizedLine || chunk.length === 0) {
      return;
    }
    if (lineBytes + chunk.length > MAX_CLAUDE_TRANSCRIPT_LINE_BYTES) {
      lineChunks = [];
      lineBytes = 0;
      skippingOversizedLine = true;
      return;
    }
    lineChunks.push(chunk);
    lineBytes += chunk.length;
  };

  const finishLine = (): void => {
    if (!skippingOversizedLine) {
      collectLine(Buffer.concat(lineChunks, lineBytes), lineIndex, true);
    }
    lineChunks = [];
    lineBytes = 0;
    lineIndex += 1;
    skippingOversizedLine = false;
  };

  if (input.end > input.start) {
    const stream = input.handle.createReadStream({
      start: input.start,
      end: input.end - 1,
      autoClose: false,
    });
    let position = input.start;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let lineStart = 0;
        for (
          let index = chunk.indexOf(0x0a);
          index !== -1;
          index = chunk.indexOf(0x0a, lineStart)
        ) {
          appendLineChunk(chunk.subarray(lineStart, index));
          finishLine();
          lineStart = index + 1;
          nextOffset = position + lineStart;
        }
        appendLineChunk(chunk.subarray(lineStart));
        position += chunk.length;
      }

      // Match readFile/split behavior for a final record that has not been newline-terminated.
      if (lineBytes > 0 && !skippingOversizedLine) {
        collectLine(Buffer.concat(lineChunks, lineBytes), lineIndex, false);
      }
    } catch {
      // A transcript that vanishes or fails partway through yields what was read by then,
      // which is the same outcome as a truncated archive. It is not cached.
      complete = false;
    } finally {
      stream.destroy();
    }
  }

  return {
    samples,
    dedupeKeys: [...newKeys],
    tailSamples,
    nextOffset,
    nextLineIndex: lineIndex,
    complete,
  };
}

function cachedClaudeSamples(entry: ClaudeTranscriptCacheEntry): ReadonlyArray<ClaudeUsageSample> {
  return entry.tailSamples.length === 0 ? entry.samples : entry.samples.concat(entry.tailSamples);
}

// A transcript that only grew still has a newline right before the resume offset; one
// rewritten in place almost never does, and is reparsed from the start.
async function hasNewlineBefore(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) {
    return true;
  }
  const byte = await readFileRange(handle, offset - 1, 1);
  return byte.length === 1 && byte[0] === 0x0a;
}

export async function readClaudeUsageSamples(
  path: string,
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  let handle: FileHandle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const scan = await scanClaudeTranscript({
      handle,
      path,
      start: 0,
      end: size,
      lineIndex: 0,
      seenKeys: EMPTY_KEYS,
    });
    return scan.tailSamples.length === 0 ? scan.samples : scan.samples.concat(scan.tailSamples);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads a transcript through the per-file cache: unchanged files are not opened, grown
 * files are parsed from the stored offset only, and shrunk, replaced, or rewritten
 * files are parsed from the start.
 */
async function readCachedClaudeUsageSamples(
  file: ClaudeTranscriptFile,
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  const cached = claudeTranscriptCache.get(file.path);
  if (
    cached &&
    cached.ino === file.ino &&
    cached.size === file.size &&
    cached.mtimeMs === file.mtimeMs
  ) {
    return cachedClaudeSamples(cached);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(file.path, "r");
  } catch {
    claudeTranscriptCache.delete(file.path);
    return [];
  }

  try {
    const stats = await handle.stat();
    const base =
      cached &&
      cached.ino === stats.ino &&
      stats.size > cached.size &&
      (await hasNewlineBefore(handle, cached.offset))
        ? cached
        : null;
    const scan = await scanClaudeTranscript({
      handle,
      path: file.path,
      start: base?.offset ?? 0,
      end: stats.size,
      lineIndex: base?.lineCount ?? 0,
      seenKeys: base?.seenKeys ?? EMPTY_KEYS,
    });

    let seenKeys: ReadonlySet<string> = new Set(scan.dedupeKeys);
    if (base) {
      const merged = new Set(base.seenKeys);
      for (const key of scan.dedupeKeys) {
        merged.add(key);
      }
      seenKeys = merged;
    }
    const entry: ClaudeTranscriptCacheEntry = {
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      offset: scan.nextOffset,
      lineCount: scan.nextLineIndex,
      samples: base ? base.samples.concat(scan.samples) : scan.samples,
      tailSamples: scan.tailSamples,
      seenKeys,
    };
    if (scan.complete) {
      claudeTranscriptCache.set(file.path, entry);
    } else {
      claudeTranscriptCache.delete(file.path);
    }
    return cachedClaudeSamples(entry);
  } catch {
    claudeTranscriptCache.delete(file.path);
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Drops transcripts that fell out of the listing, then keeps the newest transcripts
// until MAX_CACHED_CLAUDE_USAGE_SAMPLES is reached.
function pruneClaudeTranscriptCache(files: ReadonlyArray<ClaudeTranscriptFile>): void {
  const retainedPaths = new Set<string>();
  let retainedSamples = 0;
  for (const file of files) {
    const entry = claudeTranscriptCache.get(file.path);
    if (!entry) {
      continue;
    }
    const sampleCount = entry.samples.length + entry.tailSamples.length;
    if (retainedSamples + sampleCount > MAX_CACHED_CLAUDE_USAGE_SAMPLES) {
      continue;
    }
    retainedSamples += sampleCount;
    retainedPaths.add(file.path);
  }
  for (const path of claudeTranscriptCache.keys()) {
    if (!retainedPaths.has(path)) {
      claudeTranscriptCache.delete(path);
    }
  }
}

/** Usage samples from every Claude transcript written in the last 30 days. */
export async function readRecentClaudeUsageSamples(
  projectsRoot: string,
  nowMs: number = Date.now(),
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  const transcriptFiles = await listRecentClaudeTranscriptFiles(projectsRoot, nowMs);
  const samplesByFile = await mapWithConcurrency(
    transcriptFiles,
    PROVIDER_USAGE_FILE_READ_CONCURRENCY,
    readCachedClaudeUsageSamples,
  );
  pruneClaudeTranscriptCache(transcriptFiles);
  return samplesByFile.flat();
}

async function loadCodexUsageSnapshot(input: {
  homeDir: string;
  homePath?: string;
}): Promise<UsageSnapshot | null> {
  const codexHomeDir =
    input.homePath?.trim() || process.env.CODEX_HOME || nodePath.join(input.homeDir, ".codex");
  const sessionsRoot = nodePath.join(codexHomeDir, "sessions");
  const sessionFiles = await listRecentCodexSessionFiles(sessionsRoot);
  if (sessionFiles.length === 0) {
    return null;
  }

  const sessionSummaries = (
    await mapWithConcurrency(
      sessionFiles,
      PROVIDER_USAGE_FILE_READ_CONCURRENCY,
      readCodexSessionSummary,
    )
  ).filter((summary): summary is CodexSessionSummary => summary !== null);

  if (sessionSummaries.length === 0) {
    return null;
  }

  const latestSummary = sessionSummaries.reduce((latest, current) =>
    current.timestampMs > latest.timestampMs ? current : latest,
  );
  const nowMs = Date.now();
  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;

  const recent24h = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff24h);
  const recent7d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff7d);
  const recent30d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff30d);

  return {
    provider: "codex",
    updatedAt: toIsoString(latestSummary.timestampMs),
    limits: latestSummary.limits,
    usageLines: buildUsageLines({
      tokens24h: recent24h.reduce((total, summary) => total + summary.totalTokens, 0),
      tokens7d: recent7d.reduce((total, summary) => total + summary.totalTokens, 0),
      tokens30d: recent30d.reduce((total, summary) => total + summary.totalTokens, 0),
      sessions24h: recent24h.length,
      sessions7d: recent7d.length,
      sessions30d: recent30d.length,
    }),
    source: "codex-session-archive",
  };
}

async function loadClaudeUsageSnapshot(input: { homeDir: string }): Promise<UsageSnapshot | null> {
  const usageSamples = await readRecentClaudeUsageSamples(resolveClaudeProjectsRoot(input.homeDir));
  if (usageSamples.length === 0) {
    return null;
  }

  const nowMs = Date.now();
  const cutoff24h = nowMs - ONE_DAY_MS;
  const cutoff7d = nowMs - LOOKBACK_7D_MS;
  const cutoff30d = nowMs - LOOKBACK_30D_MS;
  const recent24h = usageSamples.filter((sample) => sample.timestampMs >= cutoff24h);
  const recent7d = usageSamples.filter((sample) => sample.timestampMs >= cutoff7d);
  const recent30d = usageSamples.filter((sample) => sample.timestampMs >= cutoff30d);
  const latestSample = usageSamples.reduce((latest, current) =>
    current.timestampMs > latest.timestampMs ? current : latest,
  );

  return {
    provider: "claudeAgent",
    updatedAt: toIsoString(latestSample.timestampMs),
    limits: [],
    usageLines: buildUsageLines({
      tokens24h: recent24h.reduce((total, sample) => total + sample.totalTokens, 0),
      tokens7d: recent7d.reduce((total, sample) => total + sample.totalTokens, 0),
      tokens30d: recent30d.reduce((total, sample) => total + sample.totalTokens, 0),
      sessions24h: new Set(recent24h.map((sample) => sample.sessionId)).size,
      sessions7d: new Set(recent7d.map((sample) => sample.sessionId)).size,
      sessions30d: new Set(recent30d.map((sample) => sample.sessionId)).size,
    }),
    source: "claude-project-transcripts",
  };
}

async function loadProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  switch (input.provider) {
    case "codex":
      return loadCodexUsageSnapshot({
        homeDir: input.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    case "claudeAgent":
      return loadClaudeUsageSnapshot({ homeDir: input.homeDir });
    default:
      return null;
  }
}

async function getCachedProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  const cacheKey = `${input.provider}:${input.homeDir}:${input.homePath?.trim() ?? ""}:${process.env.CLAUDE_CONFIG_DIR?.trim() ?? ""}`;
  const nowMs = Date.now();
  const existing = usageSnapshotCache.get(cacheKey);

  if (existing && existing.expiresAtMs > nowMs) {
    return existing.value;
  }
  if (existing?.pending) {
    return existing.pending;
  }

  const pending = loadProviderUsageSnapshot(input)
    .catch(() => null)
    .then((value) => {
      usageSnapshotCache.set(cacheKey, {
        expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS,
        value,
        pending: null,
      });
      return value;
    });

  usageSnapshotCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    value: existing?.value ?? null,
    pending,
  });

  return pending;
}

export const getProviderUsageSnapshot = Effect.fn(function* (
  input: ServerGetProviderUsageSnapshotInput,
) {
  const serverConfig = yield* ServerConfig;
  return yield* Effect.tryPromise({
    try: () =>
      getCachedProviderUsageSnapshot({
        provider: input.provider,
        homeDir: serverConfig.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      }),
    catch: () => null,
  });
});

// Reused by the live-usage batch (providerUsage/index.ts) to enrich live snapshots with the
// locally-derived 24h/7d/30d token-total lines for providers that keep on-disk archives.
export async function loadLocalProviderUsageLines(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<ReadonlyArray<ServerProviderUsageLine>> {
  try {
    const snapshot = await getCachedProviderUsageSnapshot(input);
    return snapshot?.usageLines ?? [];
  } catch {
    return [];
  }
}
