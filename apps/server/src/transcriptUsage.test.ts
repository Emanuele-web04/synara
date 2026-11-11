// FILE: transcriptUsage.test.ts
// Purpose: Claude Code and Codex session-file parsing (usage, prompts, turns,
// duplicates, forks) and the cached reader that resumes grown files.
// Layer: Server usage reading tests

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeTranscriptUsageReader } from "./transcriptUsage";
import {
  initialCodexTranscriptState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  type TranscriptRecord,
} from "./transcriptUsageParsers";

const claudeResponse = (
  messageId: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-01T10:00:05.000Z",
    requestId: `req-${messageId}`,
    sessionId: "s1",
    cwd: "/work/app",
    message: { id: messageId, model: "claude-sonnet-5-5", usage },
    ...extra,
  });

const claudePrompt = (uuid: string, content: unknown) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-10-01T10:00:00.000Z",
    cwd: "/work/app",
    message: { role: "user", content },
  });

const codex = (type: string, payload: Record<string, unknown>, timestamp: string) =>
  JSON.stringify({ type, timestamp, payload });

const tokenCount = (input: number, cached: number, output: number, timestamp: string) =>
  codex(
    "event_msg",
    {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
        },
      },
    },
    timestamp,
  );

describe("parseClaudeTranscriptLine", () => {
  it("splits 1-hour cache writes and keys a response by message and request", () => {
    const record = parseClaudeTranscriptLine(
      claudeResponse("m1", {
        input_tokens: 10,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
        output_tokens: 40,
        speed: "fast",
      }),
    );
    expect(record).toMatchObject({
      kind: "usage",
      model: "claude-sonnet-5-5",
      cwd: "/work/app",
      tokens: {
        inputTokens: 10,
        cacheReadTokens: 500,
        cacheWrite5mTokens: 100,
        cacheWrite1hTokens: 200,
        outputTokens: 40,
      },
      fast: true,
      failed: false,
      dedupeKey: "m1:req-m1",
    });
  });

  it("counts typed prompts as turns, not tool results, meta lines or subagents", () => {
    expect(parseClaudeTranscriptLine(claudePrompt("u1", "fix the bug"))).toMatchObject({
      kind: "turn",
      dedupeKey: "prompt:u1",
    });
    expect(
      parseClaudeTranscriptLine(claudePrompt("u2", [{ type: "text", text: "and this" }])),
    ).toMatchObject({ kind: "turn" });
    expect(
      parseClaudeTranscriptLine(
        claudePrompt("u3", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      ),
    ).toBeNull();
    const meta = JSON.parse(claudePrompt("u4", "<local-command>")) as Record<string, unknown>;
    expect(parseClaudeTranscriptLine(JSON.stringify({ ...meta, isMeta: true }))).toBeNull();
    expect(parseClaudeTranscriptLine(JSON.stringify({ ...meta, isSidechain: true }))).toBeNull();
  });

  it("marks API errors as failed", () => {
    const record = parseClaudeTranscriptLine(
      JSON.stringify({
        type: "assistant",
        uuid: "e1",
        timestamp: "2026-10-01T10:00:05.000Z",
        isApiErrorMessage: true,
        message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    );
    expect(record).toMatchObject({ kind: "usage", failed: true, dedupeKey: "error:e1" });
  });
});

describe("parseCodexTranscriptLine", () => {
  it("carries the model forward, skips re-emitted events, and counts turns", () => {
    const state = initialCodexTranscriptState();
    const lines = [
      codex("session_meta", { id: "c1", cwd: "/work/app" }, "2026-10-01T10:00:00.000Z"),
      // No model yet: ignored, and it does not take the duplicate signature.
      tokenCount(100, 0, 10, "2026-10-01T10:00:01.000Z"),
      codex(
        "turn_context",
        { turn_id: "t1", model: "gpt-6.1-sol", cwd: "/work/app" },
        "2026-10-01T10:00:02.000Z",
      ),
      tokenCount(100, 0, 10, "2026-10-01T10:00:03.000Z"),
      tokenCount(100, 0, 10, "2026-10-01T10:00:04.000Z"),
      tokenCount(1_000, 800, 20, "2026-10-01T10:00:09.000Z"),
    ];
    const records = lines
      .map((line) => parseCodexTranscriptLine(line, state))
      .filter((record): record is TranscriptRecord => record !== null);
    expect(records.map((record) => record.kind)).toEqual(["turn", "usage", "usage"]);
    expect(records[2]).toMatchObject({
      model: "gpt-6.1-sol",
      tokens: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 20 },
    });
  });

  it("drops the parent history a fork copies in at its start", () => {
    const state = initialCodexTranscriptState();
    const lines = [
      codex("session_meta", { id: "fork", forked_from_id: "c1" }, "2026-10-01T11:00:00.000Z"),
      codex("turn_context", { turn_id: "t1", model: "gpt-6.1-sol" }, "2026-10-01T11:00:00.010Z"),
      tokenCount(100, 0, 10, "2026-10-01T11:00:00.020Z"),
      tokenCount(200, 0, 10, "2026-10-01T11:00:00.030Z"),
      tokenCount(300, 0, 10, "2026-10-01T11:00:08.000Z"),
    ];
    const usage = lines
      .map((line) => parseCodexTranscriptLine(line, state))
      .filter((record) => record?.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ tokens: { inputTokens: 300 } });
  });
});

describe("makeTranscriptUsageReader", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
    );
  });

  it("reads nested files, then only what was appended", async () => {
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "transcripts-"));
    directories.push(root);
    const claudeRoot = nodePath.join(root, "claude");
    const file = nodePath.join(claudeRoot, "project", "subagents", "agent.jsonl");
    await fs.mkdir(nodePath.dirname(file), { recursive: true });
    const usage = { input_tokens: 1, output_tokens: 1 };
    await fs.writeFile(file, `${claudePrompt("u1", "go")}\n${claudeResponse("m1", usage)}\n`);

    const reader = makeTranscriptUsageReader([
      { provider: "claudeAgent", path: claudeRoot },
      { provider: "codex", path: nodePath.join(root, "missing") },
    ]);
    const first = await reader.scan(0);
    expect(first.files.flat().map((record) => record.kind)).toEqual(["turn", "usage"]);

    // A line without its newline counts now and once more after it is finished.
    await fs.appendFile(file, claudeResponse("m2", usage));
    expect((await reader.scan(0)).files.flat()).toHaveLength(3);
    await fs.appendFile(file, "\n");
    expect((await reader.scan(0)).files.flat()).toHaveLength(3);

    // Files last written before the window are not read.
    expect((await reader.scan(Date.now() + 60_000)).files).toEqual([]);
  });
});
