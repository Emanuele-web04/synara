// Live per-agent runtime state for Claude dynamic workflows, polled from the
// run's transcript directory while it is running. `journal.jsonl` records each
// agent's start/result ({type, key, agentId} lines); `agent-<id>.jsonl` is the
// agent's transcript whose assistant lines carry `message.model`, a top-level
// `effort`, and `message.usage` (latest usage line = current context
// footprint) plus tool_use blocks. Everything here is incremental (byte offsets at line
// boundaries) and best-effort: parse failures and fs errors degrade to "no
// update", never to a thrown error.

import { Effect, FileSystem } from "effect";
import type { WorkflowAgentRuntimeSnapshot } from "@synara/contracts";

import { WORKFLOW_PROMPT_PREVIEW_CHARS } from "./claudeWorkflowScript.ts";

// Workflow transcripts and settled output files share one runaway-file limit;
// transcript growth beyond the per-tick cap is caught up on later ticks.
export const MAX_CLAUDE_WORKFLOW_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const RECENT_TOOL_NAMES = 3;

export interface ClaudeWorkflowAgentAccum {
  readonly agentId: string;
  state: "running" | "completed";
  model: string | undefined;
  effort: string | undefined;
  tokens: number | undefined;
  toolCalls: number;
  recentToolNames: Array<string>;
  promptPreview: string | undefined;
  startedAt: string | undefined;
  lastActivityAt: string | undefined;
  transcriptOffset: number;
  transcriptSkipped: boolean;
  readonly seenToolUseIds: Set<string>;
}

export interface ClaudeWorkflowRuntimeState {
  journalOffset: number;
  journalSkipped: boolean;
  // Insertion order is journal start order; it is what labels zip against.
  readonly agents: Map<string, ClaudeWorkflowAgentAccum>;
}

export function makeClaudeWorkflowRuntimeState(): ClaudeWorkflowRuntimeState {
  return { journalOffset: 0, journalSkipped: false, agents: new Map() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function makeAgentAccum(agentId: string): ClaudeWorkflowAgentAccum {
  return {
    agentId,
    state: "running",
    model: undefined,
    effort: undefined,
    tokens: undefined,
    toolCalls: 0,
    recentToolNames: [],
    promptPreview: undefined,
    startedAt: undefined,
    lastActivityAt: undefined,
    transcriptOffset: 0,
    transcriptSkipped: false,
    seenToolUseIds: new Set(),
  };
}

// Journal lines: {"type":"started"|"result","key":"v2:<hash>","agentId":"..."}.
export function applyClaudeWorkflowJournalLines(
  state: ClaudeWorkflowRuntimeState,
  lines: ReadonlyArray<string>,
): boolean {
  let changed = false;
  for (const line of lines) {
    const record = parseJsonLine(line);
    const agentId = typeof record?.agentId === "string" ? record.agentId : undefined;
    if (!record || !agentId) {
      continue;
    }
    if (record.type === "started") {
      if (!state.agents.has(agentId)) {
        state.agents.set(agentId, makeAgentAccum(agentId));
        changed = true;
      }
    } else if (record.type === "result") {
      const agent = state.agents.get(agentId) ?? makeAgentAccum(agentId);
      state.agents.set(agentId, agent);
      if (agent.state !== "completed") {
        agent.state = "completed";
        changed = true;
      }
    }
  }
  return changed;
}

// Agent transcript lines (Claude session jsonl shape): the first plain-string
// user line is the prompt; assistant lines carry model/usage/tool_use blocks.
export function applyClaudeWorkflowAgentTranscriptLines(
  agent: ClaudeWorkflowAgentAccum,
  lines: ReadonlyArray<string>,
): boolean {
  let changed = false;
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (timestamp) {
      agent.startedAt ??= timestamp;
      if (agent.lastActivityAt !== timestamp) {
        agent.lastActivityAt = timestamp;
        changed = true;
      }
    }
    const message = asRecord(record.message);
    if (!message) {
      continue;
    }
    if (
      record.type === "user" &&
      agent.promptPreview === undefined &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    ) {
      agent.promptPreview = message.content.trim().slice(0, WORKFLOW_PROMPT_PREVIEW_CHARS);
      changed = true;
    }
    if (record.type !== "assistant") {
      continue;
    }
    if (typeof message.model === "string" && message.model.length > 0) {
      if (agent.model !== message.model) {
        agent.model = message.model;
        changed = true;
      }
    }
    // Reasoning effort rides on the transcript line itself (sibling of
    // `message`), not inside the API message payload.
    if (typeof record.effort === "string" && record.effort.length > 0) {
      if (agent.effort !== record.effort) {
        agent.effort = record.effort;
        changed = true;
      }
    }
    const usage = asRecord(message.usage);
    if (usage) {
      const total =
        (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
        (typeof usage.output_tokens === "number" ? usage.output_tokens : 0) +
        (typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0) +
        (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0);
      if (total > 0 && agent.tokens !== total) {
        agent.tokens = total;
        changed = true;
      }
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const blockRecord = asRecord(block);
        if (blockRecord?.type !== "tool_use") {
          continue;
        }
        const blockId = typeof blockRecord.id === "string" ? blockRecord.id : undefined;
        if (blockId && agent.seenToolUseIds.has(blockId)) {
          continue;
        }
        if (blockId) {
          agent.seenToolUseIds.add(blockId);
        }
        agent.toolCalls += 1;
        const name = typeof blockRecord.name === "string" ? blockRecord.name.trim() : "";
        if (name.length > 0) {
          agent.recentToolNames.push(name);
          if (agent.recentToolNames.length > RECENT_TOOL_NAMES) {
            agent.recentToolNames.splice(0, agent.recentToolNames.length - RECENT_TOOL_NAMES);
          }
        }
        changed = true;
      }
    }
  }
  return changed;
}

// Labels come from the workflow's own progress descriptions ("<phase>: <label>")
// in first-seen order; journal starts arrive in the same order, so zipping by
// index is the best available live join (settled runs are corrected by the
// output file's authoritative label/agentId pairs).
export function claudeWorkflowRuntimeSnapshots(
  state: ClaudeWorkflowRuntimeState,
  labels: ReadonlyArray<string>,
): Array<WorkflowAgentRuntimeSnapshot> {
  return Array.from(state.agents.values(), (agent, index) => {
    const label = labels[index];
    return {
      agentId: agent.agentId,
      ...(label ? { label } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      state: agent.state,
      ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
      ...(agent.toolCalls > 0 ? { toolCalls: agent.toolCalls } : {}),
      ...(agent.recentToolNames.length > 0 ? { recentToolNames: [...agent.recentToolNames] } : {}),
      ...(agent.promptPreview ? { promptPreview: agent.promptPreview } : {}),
      ...(agent.startedAt ? { startedAt: agent.startedAt } : {}),
      ...(agent.lastActivityAt ? { lastActivityAt: agent.lastActivityAt } : {}),
    };
  });
}

// Reads complete lines appended past `offset`. Only whole lines are consumed
// ('\n' is a single byte in UTF-8, so scanning bytes is safe); the trailing
// partial line stays unconsumed until a later tick.
const readAppendedLines = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  offset: number,
): Effect.Effect<{ lines: Array<string>; nextOffset: number; skipped: boolean } | undefined> =>
  Effect.gen(function* () {
    const info = yield* fileSystem.stat(path);
    const size = Number(info.size);
    if (!Number.isFinite(size) || size <= offset) {
      return undefined;
    }
    if (size > MAX_CLAUDE_WORKFLOW_FILE_BYTES) {
      return { lines: [], nextOffset: offset, skipped: true };
    }
    const file = yield* fileSystem.open(path);
    yield* file.seek(offset, "start");
    const chunk = yield* file.readAlloc(Math.min(size - offset, MAX_CHUNK_BYTES));
    if (chunk === undefined || chunk.length === 0) {
      return undefined;
    }
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return undefined;
    }
    const text = new TextDecoder().decode(chunk.subarray(0, lastNewline));
    return { lines: text.split("\n"), nextOffset: offset + lastNewline + 1, skipped: false };
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );

// Reads the settled workflow output within the same safety bound as live transcripts.
export const readClaudeWorkflowOutputText = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const info = yield* fileSystem.stat(path);
    const size = Number(info.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CLAUDE_WORKFLOW_FILE_BYTES) {
      return undefined;
    }
    const file = yield* fileSystem.open(path);
    const bytes = yield* file.readAlloc(size);
    return bytes && bytes.length > 0 ? new TextDecoder().decode(bytes) : undefined;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );

// One poll tick: fold new journal lines and per-agent transcript tails into
// `state`. Returns true when anything observable changed.
export const collectClaudeWorkflowRuntime = (
  fileSystem: FileSystem.FileSystem,
  transcriptDir: string,
  state: ClaudeWorkflowRuntimeState,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let changed = false;
    if (!state.journalSkipped) {
      const journal = yield* readAppendedLines(
        fileSystem,
        `${transcriptDir}/journal.jsonl`,
        state.journalOffset,
      );
      if (journal?.skipped) {
        state.journalSkipped = true;
      } else if (journal) {
        state.journalOffset = journal.nextOffset;
        changed = applyClaudeWorkflowJournalLines(state, journal.lines) || changed;
      }
    }
    for (const agent of state.agents.values()) {
      if (agent.transcriptSkipped) {
        continue;
      }
      const tail = yield* readAppendedLines(
        fileSystem,
        `${transcriptDir}/agent-${agent.agentId}.jsonl`,
        agent.transcriptOffset,
      );
      if (tail?.skipped) {
        agent.transcriptSkipped = true;
        continue;
      }
      if (tail) {
        agent.transcriptOffset = tail.nextOffset;
        changed = applyClaudeWorkflowAgentTranscriptLines(agent, tail.lines) || changed;
      }
    }
    return changed;
  });
