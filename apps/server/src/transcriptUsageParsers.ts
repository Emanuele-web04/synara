// FILE: transcriptUsageParsers.ts
// Purpose: Pure line parsers for the usage Claude Code and Codex write to their own
// session files, so Usage → Analytics can count sessions run anywhere on this Mac
// (the "This Mac" scope), not only Synara's chats.
// Layer: server usage parsing (pure, no filesystem).

/** Token counts for one model response. The five parts are disjoint. */
export interface TranscriptTokenCounts {
  /** Input that was neither read from nor written to the prompt cache. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  /** Cache writes kept for 5 minutes (Codex reports all of its writes here). */
  readonly cacheWrite5mTokens: number;
  /** Cache writes kept for 1 hour, billed at a higher rate than 5-minute ones. */
  readonly cacheWrite1hTokens: number;
  /** Output, reasoning included. */
  readonly outputTokens: number;
}

export type TranscriptProvider = "claudeAgent" | "codex";

/** One model response with usage, or one turn the user started. */
export type TranscriptRecord =
  | {
      readonly kind: "usage";
      readonly provider: TranscriptProvider;
      readonly timestampMs: number;
      readonly model: string;
      /** Working directory of the session, for project attribution. */
      readonly cwd: string;
      readonly tokens: TranscriptTokenCounts;
      /** A cost written in the session file itself; null when there is none. */
      readonly reportedCostUsd: number | null;
      /** Claude fast mode, billed at a model-specific multiple. */
      readonly fast: boolean;
      /** True for a request that ended in an API error instead of a response. */
      readonly failed: boolean;
      /**
       * Claude repeats one response's usage on every content block, and resumed
       * sessions copy earlier responses into new files: records with the same key
       * are one response. Null when the record is unique.
       */
      readonly dedupeKey: string | null;
    }
  | {
      readonly kind: "turn";
      readonly provider: TranscriptProvider;
      readonly timestampMs: number;
      readonly model: string;
      readonly cwd: string;
      /** Resumed and forked sessions copy earlier turns; one key is one turn. */
      readonly dedupeKey: string;
    };

export type TranscriptUsageRecord = Extract<TranscriptRecord, { kind: "usage" }>;

export function transcriptTokenTotal(tokens: TranscriptTokenCounts): number {
  return (
    tokens.inputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens +
    tokens.outputTokens
  );
}

/** All input the model read for the request, cached or not. Picks the price tier. */
export function transcriptPromptTokens(tokens: TranscriptTokenCounts): number {
  return transcriptTokenTotal(tokens) - tokens.outputTokens;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ── Claude Code ──────────────────────────────────────────────────────────

/**
 * Byte-level gate run before decoding a line. Session files are mostly tool
 * output: only assistant lines carry usage, and only user lines without a tool
 * result can be a prompt.
 */
export function claudeLineMightMatter(line: Buffer): boolean {
  if (line.includes('"usage"') && line.includes('"assistant"')) return true;
  return line.includes('"type":"user"') && !line.includes('"tool_use_id"');
}

/** A prompt the user typed: text content, not a tool result, meta line or subagent. */
function isClaudePrompt(parsed: Record<string, unknown>): boolean {
  if (parsed.isMeta === true || parsed.isSidechain === true || parsed.isCompactSummary === true) {
    return false;
  }
  const content = record(parsed.message)?.content;
  if (typeof content === "string") return content.trim().length > 0;
  return (
    Array.isArray(content) &&
    content.some((part) => record(part)?.type === "text") &&
    !content.some((part) => record(part)?.type === "tool_result")
  );
}

/** One Claude Code session line, or null when it carries no usage or prompt. */
export function parseClaudeTranscriptLine(line: string): TranscriptRecord | null {
  const parsed = record(parseJson(line));
  const timestampMs = timestamp(parsed?.timestamp);
  if (!parsed || timestampMs === null) return null;

  if (parsed.type === "user") {
    const uuid = text(parsed.uuid);
    if (!uuid || !isClaudePrompt(parsed)) return null;
    return {
      kind: "turn",
      provider: "claudeAgent",
      timestampMs,
      model: "",
      cwd: text(parsed.cwd),
      dedupeKey: `prompt:${uuid}`,
    };
  }

  if (parsed.type !== "assistant") return null;
  const message = record(parsed.message);
  const usage = record(message?.usage);
  if (!message || !usage) return null;
  const model = text(message.model);
  const failed = parsed.isApiErrorMessage === true;
  if (!model && !failed) return null;

  const messageId = text(message.id);
  const requestId = text(parsed.requestId);
  const uuid = text(parsed.uuid);
  const dedupeKey =
    messageId || requestId ? `${messageId}:${requestId}` : failed && uuid ? `error:${uuid}` : null;

  // `cache_creation_input_tokens` covers both lifetimes. When the split is
  // present, the 1-hour part is billed at its own rate.
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const cacheWrite1h = Math.min(
    cacheWrite,
    count(record(usage.cache_creation)?.ephemeral_1h_input_tokens),
  );
  const cost = parsed.costUSD;
  return {
    kind: "usage",
    provider: "claudeAgent",
    timestampMs,
    model,
    cwd: text(parsed.cwd),
    tokens: {
      inputTokens: count(usage.input_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWrite5mTokens: cacheWrite - cacheWrite1h,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens: count(usage.output_tokens),
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    fast: usage.speed === "fast",
    failed,
    dedupeKey,
  };
}

// ── Codex ────────────────────────────────────────────────────────────────

/**
 * Running state for one Codex session file. Usage events carry no model or
 * directory, so both are carried forward from the latest `turn_context`.
 */
export interface CodexTranscriptState {
  model: string;
  cwd: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  /** While true, leading usage events are copies of the parent's history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexTranscriptState(): CodexTranscriptState {
  return {
    model: "",
    cwd: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent session starts with its parent's history copied in one
 * burst, every line stamped with the fork instant. Its own first usage comes
 * after a real model turn, seconds later; one second splits the two.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

export function codexLineMightMatter(line: Buffer): boolean {
  return (
    line.includes('"token_count"') ||
    line.includes('"turn_context"') ||
    line.includes('"session_meta"')
  );
}

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true;
  if (typeof payload.parent_thread_id === "string") return true;
  const spawn = record(record(record(payload.source)?.subagent)?.thread_spawn);
  return typeof spawn?.parent_thread_id === "string";
}

/**
 * Feeds one Codex session line into `state`. Returns a usage record for a
 * `token_count` event (the delta of one request; identical consecutive events
 * are re-emissions and are skipped) and a turn record for a `turn_context`.
 */
export function parseCodexTranscriptLine(
  line: string,
  state: CodexTranscriptState,
): TranscriptRecord | null {
  const parsed = record(parseJson(line));
  const payload = record(parsed?.payload);
  if (!parsed || !payload) return null;
  const timestampMs = timestamp(parsed.timestamp);

  if (parsed.type === "session_meta") {
    // A fork repeats its ancestors' metas after its own; only the first one
    // describes this file.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    if (!state.cwd) state.cwd = text(payload.cwd);
    if (timestampMs !== null && isForkedSessionMeta(payload)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = timestampMs;
    }
    return null;
  }

  if (parsed.type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model;
    if (typeof payload.cwd === "string" && payload.cwd) state.cwd = payload.cwd;
    const turnId = text(payload.turn_id);
    if (!turnId || timestampMs === null) return null;
    return {
      kind: "turn",
      provider: "codex",
      timestampMs,
      model: state.model,
      cwd: state.cwd,
      dedupeKey: `turn:${turnId}`,
    };
  }

  if (payload.type !== "token_count") return null;
  const last = record(record(payload.info)?.last_token_usage);
  // An event before the first turn_context has no model yet. It must not take
  // the duplicate signature, or its re-emission once the model is known would
  // be skipped.
  if (!last || timestampMs === null || !state.model) return null;

  const signature = JSON.stringify(last);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const input = count(last.input_tokens);
  const cacheRead = count(last.cached_input_tokens);
  const cacheWrite = count(last.cache_write_input_tokens);
  const tokens: TranscriptTokenCounts = {
    // Codex's input count includes the cached part.
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWrite5mTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    outputTokens: count(last.output_tokens),
  };
  if (transcriptTokenTotal(tokens) === 0) return null;

  return {
    kind: "usage",
    provider: "codex",
    timestampMs,
    model: state.model,
    cwd: state.cwd,
    tokens,
    reportedCostUsd: null,
    fast: false,
    failed: false,
    // Events that survive the fork filter exist only in this file.
    dedupeKey: null,
  };
}
