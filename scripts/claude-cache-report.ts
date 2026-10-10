import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type RecordValue = Record<string, unknown>;
type Scope = "main" | "subagent" | "unknown";
const usageFields = [
  "inputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "cacheCreation1hInputTokens",
  "cacheCreation5mInputTokens",
] as const;
type Usage = Record<(typeof usageFields)[number], number | null>;
type Prompt = { line: number; at: string | null };

interface Request {
  firstLine: number;
  lastLine: number;
  firstAssistantAt: string | null;
  lastAssistantAt: string | null;
  stream: number;
  scope: Scope;
  model: string | null;
  version: string | null;
  entrypoint: string | null;
  usage: Usage;
  diagnostic: { type: string; missedInputTokens: number | null } | null;
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function seconds(before: string | null, after: string | null): number | null {
  return before !== null && after !== null
    ? (Date.parse(after) - Date.parse(before)) / 1_000
    : null;
}

function usage(value: unknown): Usage {
  const u = record(value);
  const cache = record(u.cache_creation);
  return {
    inputTokens: count(u.input_tokens),
    cacheReadInputTokens: count(u.cache_read_input_tokens),
    cacheCreationInputTokens: count(u.cache_creation_input_tokens),
    outputTokens: count(u.output_tokens),
    cacheCreation1hInputTokens: count(cache.ephemeral_1h_input_tokens),
    cacheCreation5mInputTokens: count(cache.ephemeral_5m_input_tokens),
  };
}

function summarize(requests: readonly Request[]) {
  const tokens = Object.fromEntries(usageFields.map((field) => [field, 0])) as Record<
    keyof Usage,
    number
  >;
  const missingCounters = { ...tokens };
  for (const request of requests) {
    for (const field of usageFields) {
      const value = request.usage[field];
      if (value === null) missingCounters[field]++;
      else tokens[field] += value;
    }
  }
  return { requests: requests.length, tokens, missingCounters };
}

/** metadata only; never retains or exports transcript text or tool payloads */
export async function analyzeClaudeCache(lines: Iterable<string> | AsyncIterable<string>) {
  const requests = new Map<string, Request>();
  const streams = new Map<string, { id: number; comparable: boolean; prompts: Prompt[] }>();
  const compactions: {
    line: number;
    at: string | null;
    stream: number;
    trigger: string | null;
    preTokens: number | null;
    postTokens: number | null;
  }[] = [];
  let line = 0;
  let assistantBlocks = 0;
  let skippedSyntheticBlocks = 0;
  let assistantBlocksWithoutId = 0;

  for await (const source of lines) {
    line++;
    if (!source.trim()) continue;
    let row: RecordValue;
    try {
      row = record(JSON.parse(source));
    } catch {
      // JSON parser errors can quote private transcript content
      throw new Error(`Invalid JSON at line ${line}.`);
    }
    const session = text(row.sessionId) ?? text(row.session_id) ?? "";
    const child = text(row.agentId) ?? text(row.agent_id) ?? text(row.parent_tool_use_id);
    const scope: Scope =
      child !== null || row.isSidechain === true
        ? "subagent"
        : row.isSidechain === false || row.parent_tool_use_id === null
          ? "main"
          : "unknown";
    const streamKey = JSON.stringify([session, scope, child]);
    let stream = streams.get(streamKey);
    if (!stream) {
      stream = {
        id: streams.size + 1,
        comparable: scope === "main" || child !== null,
        prompts: [],
      };
      streams.set(streamKey, stream);
    }
    const at = timestamp(row.timestamp);
    const message = record(row.message);
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    if (
      row.type === "user" &&
      !row.isMeta &&
      !row.isCompactSummary &&
      !row.sourceToolUseID &&
      !content.some((block) => block.type === "tool_result") &&
      (typeof message.content === "string" || content.some((block) => block.type === "text"))
    ) {
      stream.prompts.push({ line, at });
    }
    if (row.type === "system" && row.subtype === "compact_boundary") {
      const compact = record(row.compactMetadata ?? row.compact_metadata);
      compactions.push({
        line,
        at,
        stream: stream.id,
        trigger: text(compact.trigger),
        preTokens: count(compact.preTokens) ?? count(compact.pre_tokens),
        postTokens: count(compact.postTokens) ?? count(compact.post_tokens),
      });
    }
    if (row.type !== "assistant") continue;
    if (message.model === "<synthetic>" || row.isApiErrorMessage === true) {
      skippedSyntheticBlocks++;
      continue;
    }
    assistantBlocks++;
    const id = text(message.id) ?? text(row.requestId);
    if (id === null) {
      assistantBlocksWithoutId++;
      continue;
    }
    const key = JSON.stringify([session, id]);
    let request = requests.get(key);
    if (!request) {
      request = {
        firstLine: line,
        lastLine: line,
        firstAssistantAt: at,
        lastAssistantAt: at,
        stream: stream.id,
        scope,
        model: text(message.model),
        version: text(row.version),
        entrypoint: text(row.entrypoint),
        usage: usage(undefined),
        diagnostic: null,
      };
      requests.set(key, request);
    }
    // mirrored blocks can reveal child ownership after the first appearance
    if (scope === "subagent" || request.scope === "unknown") {
      request.scope = scope;
      request.stream = stream.id;
    }
    request.lastLine = line;
    request.lastAssistantAt = at ?? request.lastAssistantAt;
    const current = usage(message.usage);
    // streaming blocks may carry partial counters; the last available value wins
    for (const field of usageFields) {
      if (current[field] !== null) request.usage[field] = current[field];
    }
    const reason = record(record(message.diagnostics).cache_miss_reason);
    const reasonType = text(reason.type);
    if (reasonType !== null) {
      request.diagnostic = {
        type: reasonType,
        missedInputTokens: count(reason.cache_missed_input_tokens),
      };
    }
  }

  const values = [...requests.values()];
  const comparableStreams = new Set(
    [...streams.values()].filter((stream) => stream.comparable).map((stream) => stream.id),
  );
  const previousByStream = new Map<number, Request>();
  const promptsByStream = new Map(
    [...streams.values()].map((stream) => [stream.id, stream.prompts]),
  );
  const promptCursorByStream = new Map<number, number>();
  const timeline = values.map((request) => {
    const previous = previousByStream.get(request.stream);
    previousByStream.set(request.stream, request);
    const comparable = previous !== undefined && comparableStreams.has(request.stream);
    const prompts = promptsByStream.get(request.stream) ?? [];
    let cursor = promptCursorByStream.get(request.stream) ?? 0;
    if (previous) {
      while (prompts[cursor] && prompts[cursor]!.line <= previous.lastLine) cursor++;
    }
    promptCursorByStream.set(request.stream, cursor);
    const candidate = prompts[cursor];
    const newPrompt =
      comparable && candidate && candidate.line < request.firstLine ? candidate : null;
    const { inputTokens, cacheReadInputTokens, cacheCreationInputTokens } = request.usage;
    return {
      ...request,
      contextTokens:
        inputTokens === null || cacheReadInputTokens === null || cacheCreationInputTokens === null
          ? null
          : inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
      previousFinalToFirstAssistantSeconds: comparable
        ? seconds(previous.lastAssistantAt, request.firstAssistantAt)
        : null,
      newPrompt,
      idleBeforePromptSeconds:
        comparable && newPrompt !== null ? seconds(previous.lastAssistantAt, newPrompt.at) : null,
    };
  });
  return {
    formatVersion: 1,
    lines: line,
    assistantBlocks,
    skippedSyntheticBlocks,
    assistantBlocksWithoutId,
    totals: summarize(values),
    byScope: Object.fromEntries(
      (["main", "subagent", "unknown"] as const).map((scope) => [
        scope,
        summarize(values.filter((request) => request.scope === scope)),
      ]),
    ),
    compactions,
    timeline,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.log("Usage: node scripts/claude-cache-report.ts <transcript.jsonl> > report.json");
    process.exitCode = args[0] === "--help" ? 0 : 1;
  } else {
    try {
      const lines = createInterface({ input: createReadStream(args[0]!), crlfDelay: Infinity });
      console.log(JSON.stringify(await analyzeClaudeCache(lines), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Unable to read JSONL input.");
      process.exitCode = 1;
    }
  }
}
