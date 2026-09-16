import { describe, expect, it } from "vitest";

import { analyzeClaudeCache } from "./claude-cache-report";

const usage = {
  input_tokens: 2,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 100,
  output_tokens: 20,
  cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
};
const assistant = (id: string, timestamp: string, overrides = {}) => ({
  type: "assistant",
  sessionId: "private-session",
  isSidechain: false,
  timestamp,
  message: { id, model: "claude-test", usage, content: [{ type: "text", text: "PRIVATE" }] },
  ...overrides,
});
const analyze = (rows: unknown[]) => analyzeClaudeCache(rows.map((row) => JSON.stringify(row)));

describe("Claude cache report", () => {
  it("deduplicates blocks, ignores aggregate results, and measures gaps from the final block", async () => {
    const report = await analyze([
      assistant("one", "2026-01-01T00:00:00Z"),
      assistant("one", "2026-01-01T00:02:00Z"),
      { type: "result", usage, total_cost_usd: 99 },
      {
        type: "user",
        sessionId: "private-session",
        isSidechain: false,
        timestamp: "2026-01-01T00:32:00Z",
        message: { content: [{ type: "text", text: "PRIVATE prompt" }] },
      },
      {
        type: "user",
        sessionId: "private-session",
        isSidechain: false,
        timestamp: "2026-01-01T00:32:05Z",
        message: { content: "PRIVATE second prompt before the response" },
      },
      assistant("two", "2026-01-01T00:32:10Z"),
    ]);
    expect(report.totals.requests).toBe(2);
    expect(report.totals.tokens.cacheReadInputTokens).toBe(2_000);
    expect(report.timeline[1]).toMatchObject({
      contextTokens: 1_102,
      previousFinalToFirstAssistantSeconds: 1_810,
      idleBeforePromptSeconds: 1_800,
      newPrompt: { line: 4, at: "2026-01-01T00:32:00.000Z" },
    });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private-session|total_cost/u);
  });

  it("keeps partial usage and unknown counters distinct from zero", async () => {
    const report = await analyze([
      assistant("one", "2026-01-01T00:00:00Z", {
        message: { id: "one", usage: { input_tokens: 3, output_tokens: 0 } },
      }),
      assistant("one", "2026-01-01T00:00:01Z", {
        message: { id: "one", usage: { output_tokens: 30 } },
      }),
      assistant("error", "2026-01-01T00:00:02Z", { isApiErrorMessage: true }),
    ]);
    expect(report.timeline[0]?.usage).toMatchObject({ inputTokens: 3, outputTokens: 30 });
    expect(report.timeline[0]?.contextTokens).toBeNull();
    expect(report.totals.missingCounters.cacheReadInputTokens).toBe(1);
    expect(report.totals.missingCounters.cacheCreation1hInputTokens).toBe(1);
    expect(report.skippedSyntheticBlocks).toBe(1);
  });

  it("separates agent streams and sessions while deduplicating mirrored API messages", async () => {
    const report = await analyze([
      assistant("one", "2026-01-01T00:00:00Z"),
      assistant("child", "2026-01-01T00:00:10Z"),
      assistant("child", "2026-01-01T00:00:11Z", { agentId: "private-agent" }),
      assistant("one", "2026-01-01T00:00:20Z", { sessionId: "another-session" }),
      assistant("unknown", "2026-01-01T00:00:30Z", { isSidechain: undefined }),
    ]);
    expect(report.totals.requests).toBe(4);
    expect(report.byScope.main?.requests).toBe(2);
    expect(report.byScope.subagent?.requests).toBe(1);
    expect(report.byScope.unknown?.requests).toBe(1);
    expect(report.timeline.every((row) => row.previousFinalToFirstAssistantSeconds === null)).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain("private-agent");
  });

  it("exports only bounded diagnostic and compaction metadata", async () => {
    const report = await analyze([
      {
        type: "system",
        subtype: "compact_boundary",
        isSidechain: false,
        compactMetadata: {
          trigger: "auto",
          preTokens: 90_000,
          postTokens: 5_000,
          secret: "PRIVATE",
        },
      },
      assistant("one", "2026-01-01T00:00:00Z", {
        message: {
          id: "one",
          usage,
          diagnostics: {
            cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: 100 },
            secret: "PRIVATE",
          },
        },
      }),
    ]);
    expect(report.compactions[0]).toMatchObject({
      trigger: "auto",
      preTokens: 90_000,
      postTokens: 5_000,
    });
    expect(report.timeline[0]?.diagnostic).toEqual({
      type: "messages_changed",
      missedInputTokens: 100,
    });
    expect(report.totals.tokens.cacheCreation1hInputTokens).toBe(100);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });

  it("recognizes SDK child ownership and request IDs without inventing anonymous child gaps", async () => {
    const report = await analyze([
      assistant("sdk-main", "2026-01-01T00:00:00Z", {
        isSidechain: undefined,
        parent_tool_use_id: null,
      }),
      assistant("sdk-child", "2026-01-01T00:00:10Z", {
        isSidechain: undefined,
        parent_tool_use_id: "private-tool-id",
      }),
      assistant("anonymous", "2026-01-01T00:00:20Z", { isSidechain: true }),
      assistant("anonymous-two", "2026-01-01T00:00:30Z", { isSidechain: true }),
      assistant("fallback", "2026-01-01T00:00:40Z", {
        requestId: "private-request-id",
        message: { usage },
      }),
      assistant("missing", "2026-01-01T00:00:50Z", { message: { usage } }),
    ]);
    expect(report.byScope.main?.requests).toBe(2);
    expect(report.byScope.subagent?.requests).toBe(3);
    expect(report.assistantBlocksWithoutId).toBe(1);
    expect(report.timeline[3]?.previousFinalToFirstAssistantSeconds).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/private-tool-id|private-request-id/u);
  });

  it("reports malformed input without echoing transcript text", async () => {
    await expect(analyzeClaudeCache(["{}", '{"PRIVATE'])).rejects.toThrow(
      "Invalid JSON at line 2.",
    );
  });
});
