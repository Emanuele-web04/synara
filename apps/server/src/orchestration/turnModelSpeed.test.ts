import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { turnModelSelectionHint, TurnModelSpeedTracker } from "./turnModelSpeed.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-model-speed");
const TURN_ID = TurnId.makeUnsafe("turn-model-speed");
const START_MS = Date.parse("2026-10-04T10:00:00.000Z");

let nextEventId = 0;

function at(seconds: number): string {
  return new Date(START_MS + seconds * 1_000).toISOString();
}

function event(
  seconds: number,
  input: Record<string, unknown> & { type: ProviderRuntimeEvent["type"] },
): ProviderRuntimeEvent {
  nextEventId += 1;
  return {
    eventId: EventId.makeUnsafe(`event-${nextEventId}`),
    provider: "codex",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: at(seconds),
    providerRefs: { providerThreadId: "provider-thread" },
    ...input,
  } as ProviderRuntimeEvent;
}

function turnStarted(seconds: number, provider = "codex", turnId: string = TURN_ID) {
  return event(seconds, {
    type: "turn.started",
    provider,
    turnId,
    payload: provider === "codex" ? { model: "gpt-5-codex" } : {},
  });
}

function turnCompleted(
  seconds: number,
  input: { provider?: string; state?: string; usage?: unknown; turnId?: string } = {},
) {
  return event(seconds, {
    type: "turn.completed",
    provider: input.provider ?? "codex",
    turnId: input.turnId ?? TURN_ID,
    payload: {
      state: input.state ?? "completed",
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    },
  });
}

function codexUsage(
  seconds: number,
  cumulativeOutput: number,
  lastOutput: number,
  turnId: string = TURN_ID,
) {
  return event(seconds, {
    type: "thread.token-usage.updated",
    turnId,
    payload: {
      usage: {
        usedTokens: 10_000,
        cumulativeUsage: { inputTokens: 50_000, outputTokens: cumulativeOutput },
        outputTokens: lastOutput,
        lastOutputTokens: lastOutput,
      },
    },
  });
}

function tool(
  seconds: number,
  type: "item.started" | "item.updated" | "item.completed",
  itemId: string,
  input: { provider?: string; data?: unknown; itemType?: string } = {},
) {
  return event(seconds, {
    type,
    provider: input.provider ?? "codex",
    itemId,
    payload: {
      itemType: input.itemType ?? "command_execution",
      status: type === "item.completed" ? "completed" : "inProgress",
      ...(input.data !== undefined ? { data: input.data } : {}),
    },
  });
}

function feed(tracker: TurnModelSpeedTracker, events: ReadonlyArray<ProviderRuntimeEvent>) {
  return events.map((runtimeEvent) => tracker.observe(THREAD_ID, runtimeEvent));
}

describe("TurnModelSpeedTracker", () => {
  it("measures Codex output as the cumulative delta across several requests", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      // Previous turn's final counter is the baseline.
      codexUsage(-5, 1_000, 300, "turn-previous"),
      turnStarted(0),
      codexUsage(4, 1_400, 400),
      tool(4, "item.started", "cmd-1"),
      tool(14, "item.completed", "cmd-1"),
      codexUsage(20, 2_000, 600),
      turnCompleted(20),
    ]);
    // 1,000 output tokens over 20s wall time minus 10s of command execution.
    expect(results.at(-1)).toEqual({
      live: false,
      speed: {
        outputTokens: 1_000,
        generationMs: 10_000,
        provider: "codex",
        model: "gpt-5-codex",
        fastMode: false,
      },
    });
  });

  it("falls back to the first in-turn request when no prior counter exists", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      turnStarted(0),
      // 5,000 tokens from earlier sessions; this request produced 400.
      codexUsage(4, 5_400, 400),
      codexUsage(10, 6_000, 600),
      turnCompleted(10),
    ]);
    expect(results.at(-1)?.speed.outputTokens).toBe(1_000);
  });

  it("excludes the union of tools and pending approvals once", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      turnStarted(0),
      tool(2, "item.started", "cmd-1"),
      event(3, { type: "request.opened", requestId: "approval-1", payload: {} }),
      // Parallel tool inside the same window.
      tool(4, "item.started", "cmd-2"),
      tool(6, "item.completed", "cmd-2"),
      event(8, { type: "request.resolved", requestId: "approval-1", payload: {} }),
      tool(10, "item.completed", "cmd-1"),
      event(12, { type: "user-input.requested", requestId: "input-1", payload: {} }),
      event(15, { type: "user-input.resolved", requestId: "input-1", payload: {} }),
      codexUsage(20, 500, 500),
      turnCompleted(20),
    ]);
    // Wall 20s minus [2,10] and [12,15] = 9s.
    expect(results.at(-1)?.speed.generationMs).toBe(9_000);
  });

  it("counts only Claude main-loop output, never subagent usage", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      turnStarted(0, "claudeAgent"),
      tool(2, "item.started", "task-1", {
        provider: "claudeAgent",
        itemType: "collab_agent_tool_call",
      }),
      // The Task tool's subagent runs for 30 minutes; that time is excluded.
      tool(1_802, "item.completed", "task-1", {
        provider: "claudeAgent",
        itemType: "collab_agent_tool_call",
      }),
      turnCompleted(1_810, {
        provider: "claudeAgent",
        // result.usage is the main loop; modelUsage would add the subagent's
        // 2M output tokens and report ~200,000 tok/s.
        usage: { input_tokens: 10, output_tokens: 1_000 },
      }),
    ]);
    expect(results.at(-1)?.speed).toEqual({
      outputTokens: 1_000,
      generationMs: 10_000,
      provider: "claudeAgent",
      fastMode: false,
    });
  });

  it("counts Claude tool-input streaming as generation time", () => {
    const tracker = new TurnModelSpeedTracker();
    const claude = { provider: "claudeAgent" };
    const results = feed(tracker, [
      turnStarted(0, "claudeAgent"),
      // Tool block opens while the model is still writing the file content.
      tool(2, "item.started", "write-1", { ...claude, itemType: "file_change" }),
      tool(6, "item.updated", "write-1", { ...claude, itemType: "file_change" }),
      // Result-bearing update: execution already running, start stays at 6s.
      tool(8, "item.updated", "write-1", {
        ...claude,
        itemType: "file_change",
        data: { result: { ok: true } },
      }),
      tool(8, "item.completed", "write-1", { ...claude, itemType: "file_change" }),
      turnCompleted(10, { provider: "claudeAgent", usage: { output_tokens: 800 } }),
    ]);
    expect(results.at(-1)?.speed.generationMs).toBe(8_000);
  });

  it("reports nothing for interrupted, failed, tiny, or implausible turns", () => {
    const interrupted = new TurnModelSpeedTracker();
    expect(
      feed(interrupted, [
        turnStarted(0),
        codexUsage(5, 600, 600),
        turnCompleted(10, { state: "interrupted" }),
      ]).at(-1),
    ).toBeUndefined();

    const tiny = new TurnModelSpeedTracker();
    expect(
      feed(tiny, [turnStarted(0), codexUsage(5, 10, 10), turnCompleted(10)]).at(-1),
    ).toBeUndefined();

    const subSecond = new TurnModelSpeedTracker();
    expect(
      feed(subSecond, [
        turnStarted(0),
        tool(0.1, "item.started", "cmd-1"),
        tool(9.5, "item.completed", "cmd-1"),
        codexUsage(10, 500, 500),
        turnCompleted(10),
      ]).at(-1),
    ).toBeUndefined();

    const implausible = new TurnModelSpeedTracker();
    expect(
      feed(implausible, [
        turnStarted(0, "claudeAgent"),
        turnCompleted(35, { provider: "claudeAgent", usage: { output_tokens: 2_061_157 } }),
      ]).at(-1),
    ).toBeUndefined();
  });

  it("does not measure a turn that started before the tracker saw it", () => {
    const tracker = new TurnModelSpeedTracker();
    expect(feed(tracker, [codexUsage(5, 600, 600), turnCompleted(10)]).at(-1)).toBeUndefined();
  });

  it("reports a live figure on each snapshot, counting open tools up to now", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      turnStarted(0),
      codexUsage(5, 500, 500),
      tool(5, "item.started", "cmd-1"),
      // Snapshot while cmd-1 still runs: 10s elapsed, 5s of it the open tool.
      codexUsage(10, 1_000, 500),
      tool(15, "item.completed", "cmd-1"),
      codexUsage(20, 1_500, 500),
      turnCompleted(20),
    ]);
    expect(results[1]).toEqual({
      live: true,
      speed: {
        outputTokens: 500,
        generationMs: 5_000,
        provider: "codex",
        model: "gpt-5-codex",
        fastMode: false,
      },
    });
    expect(results[3]?.speed).toMatchObject({ outputTokens: 1_000, generationMs: 5_000 });
    expect(results[5]?.speed).toMatchObject({ outputTokens: 1_500, generationMs: 10_000 });
    // The settled figure uses the same measurement.
    expect(results[6]).toEqual({ ...results[5], live: false });
  });

  it("uses Claude's running main-loop output for the live figure", () => {
    const tracker = new TurnModelSpeedTracker();
    const claudeUsage = (seconds: number, turnOutputTokens?: number) =>
      event(seconds, {
        type: "thread.token-usage.updated",
        provider: "claudeAgent",
        payload: {
          usage: {
            usedTokens: 20_000,
            // Streaming-start count of the latest request; never summed.
            outputTokens: 4,
            ...(turnOutputTokens !== undefined ? { turnOutputTokens } : {}),
          },
        },
      });
    const results = feed(tracker, [
      turnStarted(0, "claudeAgent"),
      claudeUsage(2),
      claudeUsage(4, 600),
      turnCompleted(6, { provider: "claudeAgent", usage: { output_tokens: 700 } }),
    ]);
    expect(results[1]).toBeUndefined();
    expect(results[2]).toMatchObject({
      live: true,
      speed: { outputTokens: 600, generationMs: 4_000 },
    });
    expect(results[3]).toMatchObject({
      live: false,
      speed: { outputTokens: 700, generationMs: 6_000 },
    });
  });

  it("measures Pi from its session-cumulative output counter", () => {
    const tracker = new TurnModelSpeedTracker();
    const piUsage = (seconds: number, outputTokens: number, turnId?: string) =>
      event(seconds, {
        type: "thread.token-usage.updated",
        provider: "pi",
        ...(turnId ? { turnId } : { turnId: undefined }),
        payload: { usage: { usedTokens: 1_000, outputTokens } },
      });
    const results = feed(tracker, [
      piUsage(-1, 2_000),
      turnStarted(0, "pi"),
      piUsage(8, 2_800, TURN_ID),
      turnCompleted(8, { provider: "pi" }),
    ]);
    expect(results.at(-1)?.speed).toMatchObject({ outputTokens: 800, generationMs: 8_000 });
  });

  it("records the provider-reported model, fast mode, and effort of the turn", () => {
    const tracker = new TurnModelSpeedTracker();
    const selection = { model: "claude-opus-4-8", fastMode: true, effort: "high" };
    const results = [
      tracker.observe(
        THREAD_ID,
        event(0, {
          type: "turn.started",
          provider: "claudeAgent",
          // Provider-reported model wins over the thread's persisted selection.
          payload: { model: "claude-opus-5-5" },
        }),
        selection,
      ),
      tracker.observe(
        THREAD_ID,
        turnCompleted(10, { provider: "claudeAgent", usage: { output_tokens: 900 } }),
      ),
    ];
    expect(results[1]?.speed).toEqual({
      outputTokens: 900,
      generationMs: 10_000,
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      fastMode: true,
      effort: "high",
    });
  });

  it("follows a reroute and treats -fast slugs as fast mode", () => {
    const tracker = new TurnModelSpeedTracker();
    tracker.observe(THREAD_ID, turnStarted(0), { model: "gpt-5.5", effort: "medium" });
    tracker.observe(
      THREAD_ID,
      event(1, {
        type: "model.rerouted",
        payload: { fromModel: "gpt-5.5", toModel: "gpt-5.5-fast", reason: "capacity" },
      }),
    );
    tracker.observe(THREAD_ID, codexUsage(5, 600, 600));
    const settled = tracker.observe(THREAD_ID, turnCompleted(10));
    expect(settled?.speed).toMatchObject({
      model: "gpt-5.5-fast",
      fastMode: true,
      // Codex reports its effort on turn.started; the selection fills it in otherwise.
      effort: "medium",
    });
  });

  it("does not measure providers without a turn-attributable output counter", () => {
    const tracker = new TurnModelSpeedTracker();
    const results = feed(tracker, [
      turnStarted(0, "opencode"),
      event(5, {
        type: "thread.token-usage.updated",
        provider: "opencode",
        payload: { usage: { usedTokens: 1_000, outputTokens: 500, lastOutputTokens: 500 } },
      }),
      turnCompleted(10, { provider: "opencode" }),
    ]);
    expect(results.every((result) => result === undefined)).toBe(true);
  });
});

describe("turnModelSelectionHint", () => {
  const selection = (model: string, options?: Record<string, unknown>) =>
    ({
      provider: "codex",
      instanceId: "codex",
      model,
      ...(options ? { options } : {}),
    }) as unknown as Parameters<typeof turnModelSelectionHint>[0];

  it("falls back to the model's default effort, as the picker shows it", () => {
    expect(turnModelSelectionHint(selection("gpt-5.4"))).toEqual({
      model: "gpt-5.4",
      effort: "high",
    });
    expect(turnModelSelectionHint(selection("gpt-5.5"))?.effort).toBe("medium");
  });

  it("keeps an explicit effort and fast mode, and omits an unknown default", () => {
    expect(
      turnModelSelectionHint(selection("gpt-5.5", { reasoningEffort: "xhigh", fastMode: true })),
    ).toEqual({ model: "gpt-5.5", effort: "xhigh", fastMode: true });
    expect(turnModelSelectionHint(selection("some-new-model"))).toEqual({
      model: "some-new-model",
    });
  });
});
