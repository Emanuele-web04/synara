import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem } from "effect";

import {
  applyClaudeWorkflowAgentTranscriptLines,
  applyClaudeWorkflowJournalLines,
  claudeWorkflowRuntimeSnapshots,
  collectClaudeWorkflowRuntime,
  MAX_CLAUDE_WORKFLOW_FILE_BYTES,
  makeClaudeWorkflowRuntimeState,
  readClaudeWorkflowOutputText,
  type ClaudeWorkflowAgentAccum,
} from "./claudeWorkflowRuntime.ts";

// Line shapes mirror a real run's transcript directory
// (~/.claude/projects/<session>/subagents/workflows/wf_*/): journal.jsonl
// records {type, key, agentId}; agent-<id>.jsonl is the session-jsonl shape
// whose assistant lines carry message.model/usage and tool_use blocks plus a
// top-level `effort` field (sibling of `message`).
const JOURNAL_STARTED = JSON.stringify({
  type: "started",
  key: "v2:e6b51252c782edf079b5f85ce071ce87afc52b300b3ae35c607f3b0569d47868",
  agentId: "a423ae8cef86a1ed4",
});
const JOURNAL_RESULT = JSON.stringify({
  type: "result",
  key: "v2:e6b51252c782edf079b5f85ce071ce87afc52b300b3ae35c607f3b0569d47868",
  agentId: "a423ae8cef86a1ed4",
  result: { summary: "done" },
});

const AGENT_USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: true,
  agentId: "a423ae8cef86a1ed4",
  type: "user",
  message: { role: "user", content: "Decompose this research question into angles.\n\nDetails." },
  uuid: "739ba77b-c237-4aa7-be85-e9392ea1fc36",
  timestamp: "2026-07-14T22:48:58.400Z",
});
const AGENT_THINKING_LINE = JSON.stringify({
  type: "assistant",
  agentId: "a423ae8cef84e1ed4",
  message: {
    id: "msg_011",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "thinking", thinking: "..." }],
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 17276,
      cache_read_input_tokens: 0,
      output_tokens: 8,
    },
  },
  timestamp: "2026-07-14T22:49:14.027Z",
});
const AGENT_TOOL_USE_LINE = JSON.stringify({
  type: "assistant",
  effort: "high",
  message: {
    id: "msg_011",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "toolu_01", name: "WebSearch", input: { query: "x" } }],
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 17276,
      cache_read_input_tokens: 0,
      output_tokens: 97,
    },
  },
  timestamp: "2026-07-14T22:49:14.490Z",
});
const AGENT_FINAL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_012",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "toolu_02", name: "StructuredOutput", input: {} }],
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 946,
      cache_read_input_tokens: 20318,
      output_tokens: 34,
    },
  },
  timestamp: "2026-07-14T22:50:15.338Z",
});

function agentAccum(): ClaudeWorkflowAgentAccum {
  const state = makeClaudeWorkflowRuntimeState();
  applyClaudeWorkflowJournalLines(state, [JOURNAL_STARTED]);
  return state.agents.get("a423ae8cef86a1ed4")!;
}

describe("applyClaudeWorkflowJournalLines", () => {
  it("registers agents on started and settles them on result", () => {
    const state = makeClaudeWorkflowRuntimeState();
    expect(applyClaudeWorkflowJournalLines(state, [JOURNAL_STARTED])).toBe(true);
    expect(state.agents.get("a423ae8cef86a1ed4")?.state).toBe("running");
    expect(applyClaudeWorkflowJournalLines(state, [JOURNAL_RESULT])).toBe(true);
    expect(state.agents.get("a423ae8cef86a1ed4")?.state).toBe("completed");
    // Replays and garbage are inert.
    expect(applyClaudeWorkflowJournalLines(state, [JOURNAL_RESULT, "not json", ""])).toBe(false);
    expect(state.agents.size).toBe(1);
  });

  it("keeps journal start order as agent order", () => {
    const state = makeClaudeWorkflowRuntimeState();
    applyClaudeWorkflowJournalLines(state, [
      JSON.stringify({ type: "started", key: "v2:a", agentId: "agent-1" }),
      JSON.stringify({ type: "started", key: "v2:b", agentId: "agent-2" }),
    ]);
    expect([...state.agents.keys()]).toEqual(["agent-1", "agent-2"]);
  });
});

describe("applyClaudeWorkflowAgentTranscriptLines", () => {
  it("accumulates prompt, model, latest usage total, and tool calls", () => {
    const agent = agentAccum();
    const changed = applyClaudeWorkflowAgentTranscriptLines(agent, [
      AGENT_USER_LINE,
      AGENT_THINKING_LINE,
      AGENT_TOOL_USE_LINE,
      AGENT_FINAL_LINE,
    ]);
    expect(changed).toBe(true);
    expect(agent.promptPreview).toBe("Decompose this research question into angles.\n\nDetails.");
    expect(agent.model).toBe("claude-sonnet-4-6");
    expect(agent.effort).toBe("high");
    // Latest usage line wins: 1 + 946 + 20318 + 34.
    expect(agent.tokens).toBe(21_299);
    // tool_use blocks dedupe by id across streamed line repeats.
    expect(agent.toolCalls).toBe(2);
    expect(agent.recentToolNames).toEqual(["WebSearch", "StructuredOutput"]);
    expect(agent.startedAt).toBe("2026-07-14T22:48:58.400Z");
    expect(agent.lastActivityAt).toBe("2026-07-14T22:50:15.338Z");
  });

  it("is incremental: re-fed lines with seen tool ids do not double-count", () => {
    const agent = agentAccum();
    applyClaudeWorkflowAgentTranscriptLines(agent, [AGENT_TOOL_USE_LINE]);
    applyClaudeWorkflowAgentTranscriptLines(agent, [AGENT_TOOL_USE_LINE, AGENT_FINAL_LINE]);
    expect(agent.toolCalls).toBe(2);
  });

  it("keeps only the last three tool names", () => {
    const agent = agentAccum();
    const lines = ["A", "B", "C", "D"].map((name, index) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: `msg_${index}`,
          role: "assistant",
          content: [{ type: "tool_use", id: `toolu_${index}`, name, input: {} }],
        },
      }),
    );
    applyClaudeWorkflowAgentTranscriptLines(agent, lines);
    expect(agent.toolCalls).toBe(4);
    expect(agent.recentToolNames).toEqual(["B", "C", "D"]);
  });
});

describe("claudeWorkflowRuntimeSnapshots", () => {
  it("emits effort accumulated from transcript lines", () => {
    const state = makeClaudeWorkflowRuntimeState();
    applyClaudeWorkflowJournalLines(state, [JOURNAL_STARTED]);
    applyClaudeWorkflowAgentTranscriptLines(state.agents.get("a423ae8cef86a1ed4")!, [
      AGENT_TOOL_USE_LINE,
    ]);
    const [snapshot] = claudeWorkflowRuntimeSnapshots(state, []);
    expect(snapshot?.model).toBe("claude-sonnet-4-6");
    expect(snapshot?.effort).toBe("high");
  });

  it("zips first-seen labels onto journal start order", () => {
    const state = makeClaudeWorkflowRuntimeState();
    applyClaudeWorkflowJournalLines(state, [
      JSON.stringify({ type: "started", key: "v2:a", agentId: "agent-1" }),
      JSON.stringify({ type: "started", key: "v2:b", agentId: "agent-2" }),
      JSON.stringify({ type: "started", key: "v2:c", agentId: "agent-3" }),
      JSON.stringify({ type: "result", key: "v2:a", agentId: "agent-1" }),
    ]);
    const snapshots = claudeWorkflowRuntimeSnapshots(state, ["scope", "search:pricing"]);
    expect(snapshots.map((snapshot) => [snapshot.agentId, snapshot.label, snapshot.state])).toEqual(
      [
        ["agent-1", "scope", "completed"],
        ["agent-2", "search:pricing", "running"],
        ["agent-3", undefined, "running"],
      ],
    );
  });
});

describe("collectClaudeWorkflowRuntime", () => {
  const withDir = <A>(run: (dir: string, fs: FileSystem.FileSystem) => Effect.Effect<A>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-wf-runtime-"));
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* run(dir, fileSystem);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      Effect.runPromise,
    );
  };

  it("reads journal and agent transcripts incrementally across ticks", () =>
    withDir((dir, fileSystem) =>
      Effect.gen(function* () {
        const state = makeClaudeWorkflowRuntimeState();
        // Nothing on disk yet: quiet no-op.
        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(false);

        writeFileSync(path.join(dir, "journal.jsonl"), `${JOURNAL_STARTED}\n`);
        writeFileSync(
          path.join(dir, "agent-a423ae8cef86a1ed4.jsonl"),
          `${AGENT_USER_LINE}\n${AGENT_TOOL_USE_LINE}\n`,
        );
        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(true);
        const agent = state.agents.get("a423ae8cef86a1ed4")!;
        expect(agent.state).toBe("running");
        expect(agent.toolCalls).toBe(1);
        expect(agent.tokens).toBe(3 + 17_276 + 0 + 97);

        // No growth: no change reported.
        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(false);

        // Appended lines (including a trailing partial) are picked up; the
        // partial line stays unconsumed.
        appendFileSync(
          path.join(dir, "agent-a423ae8cef86a1ed4.jsonl"),
          `${AGENT_FINAL_LINE}\n{"tr`,
        );
        appendFileSync(path.join(dir, "journal.jsonl"), `${JOURNAL_RESULT}\n`);
        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(true);
        expect(agent.state).toBe("completed");
        expect(agent.toolCalls).toBe(2);
        expect(agent.tokens).toBe(21_299);

        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(false);
      }),
    ));

  it("skips oversized transcripts and swallows fs errors", () =>
    withDir((dir, fileSystem) =>
      Effect.gen(function* () {
        const state = makeClaudeWorkflowRuntimeState();
        writeFileSync(path.join(dir, "journal.jsonl"), `${JOURNAL_STARTED}\n`);
        // 6MB of padding pushes the agent transcript over the 5MB cap.
        writeFileSync(
          path.join(dir, "agent-a423ae8cef86a1ed4.jsonl"),
          `${AGENT_USER_LINE}\n${"x".repeat(6 * 1024 * 1024)}\n`,
        );
        yield* collectClaudeWorkflowRuntime(fileSystem, dir, state);
        const agent = state.agents.get("a423ae8cef86a1ed4")!;
        expect(agent.transcriptSkipped).toBe(true);
        expect(agent.promptPreview).toBeUndefined();

        // A vanished directory degrades to "no change" rather than failing.
        rmSync(dir, { recursive: true, force: true });
        expect(yield* collectClaudeWorkflowRuntime(fileSystem, dir, state)).toBe(false);
      }),
    ));

  it("reads settled output files within the workflow file limit", () =>
    withDir((dir, fileSystem) =>
      Effect.gen(function* () {
        const outputPath = path.join(dir, "workflow-output.json");
        writeFileSync(outputPath, '{"workflowProgress":[]}');
        expect(yield* readClaudeWorkflowOutputText(fileSystem, outputPath)).toBe(
          '{"workflowProgress":[]}',
        );

        writeFileSync(outputPath, "x".repeat(MAX_CLAUDE_WORKFLOW_FILE_BYTES + 1));
        expect(yield* readClaudeWorkflowOutputText(fileSystem, outputPath)).toBeUndefined();
      }),
    ));
});
