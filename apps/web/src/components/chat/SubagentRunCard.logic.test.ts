// FILE: SubagentRunCard.logic.test.ts
// Purpose: Locks how a turn's subagents fold into one transcript card and how
// the card derives rows, counts, states, durations, nested rows, and labels.
// Layer: Web chat transcript tests

import { ThreadId, TurnId, type MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry, WorkLogSubagent } from "../../session-logic";
import {
  deriveSubagentRunCard,
  describeSubagentRunHeader,
  describeSubagentRunRow,
  findLatestRunningSubagentRun,
  firstLinePreview,
  foldSubagentRunWorkEntries,
  type SubagentRunThread,
} from "./SubagentRunCard.logic";

const PARENT = ThreadId.makeUnsafe("parent");
const launchedAtIso = "2026-10-10T00:00:00.000Z";

function entry(
  overrides: Partial<Omit<WorkLogEntry, "turnId">> & { id: string; turnId?: string | null },
): WorkLogEntry {
  const { turnId, ...rest } = overrides;
  return {
    createdAt: "2026-10-10T00:00:00.000Z",
    label: "Tool",
    tone: "tool",
    turnId: turnId === undefined ? TurnId.makeUnsafe("turn-1") : turnId ? TurnId.makeUnsafe(turnId) : null,
    ...rest,
  };
}

function spawn(id: string, createdAt: string, subagents: WorkLogSubagent[], turnId = "turn-1") {
  return entry({
    id,
    createdAt,
    turnId,
    label: "Subagent task",
    itemType: "collab_agent_tool_call",
    subagentAction: { tool: "spawnAgent", status: "completed", summaryText: "Spawning 1 agent" },
    subagents,
  });
}

function childThread(
  id: string,
  overrides: Partial<SubagentRunThread> = {},
): SubagentRunThread {
  return {
    id: ThreadId.makeUnsafe(id),
    title: "Child",
    createdAt: "2026-10-10T00:00:01.000Z",
    error: null,
    session: null,
    latestTurn: null,
    messages: [],
    activities: [],
    modelSelection: { provider: "claudeAgent", model: "claude-haiku-5-5" },
    parentThreadId: PARENT,
    sourceThreadId: PARENT,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: "general-purpose",
    ...overrides,
  };
}

function completedTurn(startedAt: string, completedAt: string, state = "completed" as const) {
  return {
    turnId: TurnId.makeUnsafe(`turn-${completedAt}`),
    state,
    requestedAt: startedAt,
    startedAt,
    completedAt,
    assistantMessageId: null,
  };
}

function assistantMessage(text: string) {
  return {
    id: `m-${text.length}` as MessageId,
    role: "assistant" as const,
    text,
    createdAt: "2026-10-10T00:00:09.000Z",
    streaming: false,
  };
}

describe("foldSubagentRunWorkEntries", () => {
  it("anchors a resumed subagent in its new launching turn and keeps late progress in the original card", () => {
    const folded = foldSubagentRunWorkEntries([
      spawn("first", launchedAtIso, [{ threadId: "a", rawStatus: "completed" }]),
      spawn("resume", "2026-10-10T00:01:00.000Z", [{ threadId: "a", rawStatus: "running" }], "turn-2"),
      entry({
        id: "late-progress", tone: "info", turnId: "turn-1", detail: "Read README.md",
        subagentProgress: { toolUseId: "a", title: "Read", outcome: "completed" },
      }),
    ]);
    expect(folded.map((item) => item.id)).toEqual(["subagent-run:first", "subagent-run:resume"]);
    expect(folded[0]!.subagents?.[0]?.rawStatus).toBe("completed");
    expect(folded[0]!.subagentRun?.members[0]?.latestStep).toBe("Read README.md");
    expect(folded[1]!.subagentRun?.members[0]?.latestStep).toBeNull();
  });

  it("folds a turn's launches and progress into one card at the first launch", () => {
    const entries = [
      entry({ id: "read", label: "Read calc.py" }),
      spawn("spawn-a", "2026-10-10T00:00:01.000Z", [
        { threadId: "toolu_a", providerThreadId: "toolu_a", nickname: "Count lines" },
      ]),
      spawn("spawn-b", "2026-10-10T00:00:02.000Z", [
        { threadId: "toolu_b", providerThreadId: "toolu_b", nickname: "Read README" },
      ]),
      entry({
        id: "progress-a",
        tone: "info",
        detail: "Running Wait 8 seconds then count lines",
        subagentProgress: { toolUseId: "toolu_a", title: "Count lines", outcome: "completed" },
      }),
      entry({ id: "after", label: "Ran ls" }),
    ];

    const folded = foldSubagentRunWorkEntries(entries);

    expect(folded.map((item) => item.id)).toEqual(["read", "subagent-run:spawn-a", "after"]);
    const card = folded[1]!;
    expect(card.tone).toBe("info");
    expect(card.subagents?.map((subagent) => subagent.threadId)).toEqual(["toolu_a", "toolu_b"]);
    expect(card.subagentRun?.members).toEqual([
      {
        key: "toolu_a",
        launchedAt: "2026-10-10T00:00:01.000Z",
        latestStep: "Running Wait 8 seconds then count lines",
        outcome: "completed",
        failure: null,
        settledAt: null,
      },
      {
        key: "toolu_b",
        launchedAt: "2026-10-10T00:00:02.000Z",
        latestStep: null,
        outcome: null,
        failure: null,
        settledAt: null,
      },
    ]);
  });

  it("keeps one card per turn and lets later state-only calls update known rows", () => {
    const folded = foldSubagentRunWorkEntries([
      spawn("spawn-1", "2026-10-10T00:00:01.000Z", [{ threadId: "agent-1", rawStatus: "running" }]),
      spawn("spawn-2", "2026-10-10T00:01:00.000Z", [{ threadId: "agent-2" }], "turn-2"),
      entry({
        id: "wait",
        turnId: "turn-2",
        itemType: "collab_agent_tool_call",
        subagentAction: { tool: "wait", status: "completed", summaryText: "Waited" },
        subagents: [
          { threadId: "agent-1", rawStatus: "completed" },
          { threadId: "unknown-agent", rawStatus: "completed" },
        ],
      }),
    ]);

    expect(folded.map((item) => item.id)).toEqual([
      "subagent-run:spawn-1",
      "subagent-run:spawn-2",
    ]);
    expect(folded[0]!.subagents).toEqual([{ threadId: "agent-1", rawStatus: "completed" }]);
    expect(folded[1]!.subagents?.map((subagent) => subagent.threadId)).toEqual(["agent-2"]);
  });

  it("does not read a Codex spawn call's completion as the subagent finishing", () => {
    const launch = spawn("spawn-codex", "2026-10-10T00:00:00.000Z", [
      { threadId: "codex-a", providerThreadId: "codex-a", nickname: "calc_wc" },
    ]);
    const settled = entry({
      id: "settled",
      createdAt: "2026-10-10T00:00:09.000Z",
      itemType: "collab_agent_tool_call",
      subagentAction: { tool: "subAgentSettled", status: "completed", summaryText: "Settled" },
      subagents: [{ threadId: "codex-a", rawStatus: "completed" }],
    });
    // Codex children have no session and their turn never closes.
    const child = childThread("subagent:parent:codex-a", {
      latestTurn: { ...completedTurn(launchedAtIso, "x"), state: "running", completedAt: null },
    });
    const runCard = (entries: WorkLogEntry[], launchTurnLive = true) => {
      const folded = foldSubagentRunWorkEntries(entries)[0]!;
      return deriveSubagentRunCard({
        subagents: folded.subagents ?? [],
        run: folded.subagentRun!,
        threads: [child],
        parentThreadId: PARENT,
        launchTurnLive,
      });
    };

    expect(runCard([launch]).rows[0]!.phase).toBe("running");
    // With no settle report, the end of the launching turn is the last word.
    expect(runCard([launch], false).rows[0]!.phase).toBe("done");
    const done = runCard([launch, settled]).rows[0]!;
    expect(done.phase).toBe("done");
    expect(done.endedAtMs! - done.startedAtMs!).toBe(9_000);
  });

  it("keeps a failed launch's error as the row's cause", () => {
    const folded = foldSubagentRunWorkEntries([
      entry({
        id: "spawn-failed",
        itemType: "collab_agent_tool_call",
        detail: "Agent type 'tester' not found",
        subagentAction: { tool: "spawnAgent", status: "failed", summaryText: "Spawning 1 agent" },
        subagents: [{ threadId: "toolu_x", nickname: "Run the tests" }],
      }),
    ]);
    expect(folded[0]!.subagentRun?.members[0]?.failure).toBe("Agent type 'tester' not found");
    const model = deriveSubagentRunCard({
      subagents: folded[0]!.subagents ?? [],
      run: folded[0]!.subagentRun!,
      threads: [],
      parentThreadId: PARENT,
    });
    expect(model.rows[0]!.phase).toBe("failed");
    expect(model.rows[0]!.outcomeText).toBe("Agent type 'tester' not found");
  });

  it("returns the same array when nothing is routed to subagents", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    expect(foldSubagentRunWorkEntries(entries)).toBe(entries);
  });
});

describe("deriveSubagentRunCard", () => {
  const launchedAt = "2026-10-10T00:00:00.000Z";

  function card(
    subagents: WorkLogSubagent[],
    threads: SubagentRunThread[],
    members: Array<{
      key: string;
      latestStep?: string;
      outcome?: "completed" | "failed" | "stopped";
      failure?: string;
    }>,
  ) {
    return deriveSubagentRunCard({
      subagents,
      run: {
        members: members.map((member) => ({
          key: member.key,
          launchedAt,
          latestStep: member.latestStep ?? null,
          outcome: member.outcome ?? null,
          failure: member.failure ?? null,
          settledAt: null,
        })),
      },
      threads,
      parentThreadId: PARENT,
    });
  }

  it("derives running and done rows with durations, steps, and result previews", () => {
    const model = card(
      [
        { threadId: "a", nickname: "Read README.md", statusLabel: "Running", isActive: true },
        { threadId: "b", nickname: "Count lines", statusLabel: "Completed" },
      ],
      [
        childThread("subagent:parent:a"),
        childThread("subagent:parent:b", {
          latestTurn: completedTurn(launchedAt, "2026-10-10T00:00:08.000Z"),
          messages: [assistantMessage("## Result\n`calc.py` has 5 lines.\nMore detail")],
        }),
      ],
      [{ key: "a", latestStep: "Running cat README.md" }, { key: "b" }],
    );

    expect(model.isLive).toBe(true);
    expect(model.counts).toEqual({ running: 1, done: 1, failed: 0, stopped: 0, interrupted: 0 });
    const [running, done] = model.rows;
    expect(running!.phase).toBe("running");
    expect(running!.threadId).toBe("subagent:parent:a");
    expect(running!.action).toEqual({ command: null, label: "cat README.md" });
    expect(done!.phase).toBe("done");
    expect(done!.outcomeText).toBe("Result");
    expect(done!.endedAtMs! - done!.startedAtMs!).toBe(8_000);

    const nowMs = Date.parse(launchedAt) + 12_000;
    expect(describeSubagentRunHeader(model, nowMs)).toEqual({
      title: "2 subagents",
      nestedLabel: null,
      segments: [{ text: "1 running", tone: "running" }],
      durationLabel: "12s",
    });
    expect(describeSubagentRunRow(running!, { nowMs, allStopped: false })).toMatchObject({
      word: "Running",
      durationLabel: "12s",
      detail: { kind: "action", action: { label: "cat README.md" } },
    });
    expect(describeSubagentRunRow(done!, { nowMs, allStopped: false })).toMatchObject({
      word: "Done",
      durationLabel: "8s",
      detail: { kind: "outcome", text: "Result" },
    });
  });

  it("reads stopped and failed outcomes and colors only the failed count", () => {
    const model = card(
      [
        { threadId: "a", nickname: "Done one", statusLabel: "Completed" },
        { threadId: "b", nickname: "Tests", statusLabel: "Failed" },
        { threadId: "c", nickname: "Slow", statusLabel: "Completed" },
      ],
      [
        childThread("subagent:parent:a", {
          latestTurn: completedTurn(launchedAt, "2026-10-10T00:00:08.000Z"),
        }),
        childThread("subagent:parent:b", {
          error: "`pytest` is not installed (exit 127)",
          latestTurn: completedTurn(launchedAt, "2026-10-10T00:00:03.000Z", "error" as never),
        }),
        childThread("subagent:parent:c", {
          latestTurn: completedTurn(launchedAt, "2026-10-10T00:00:21.000Z", "interrupted" as never),
        }),
      ],
      [{ key: "a" }, { key: "b" }, { key: "c", latestStep: "Running sleep 60", outcome: "stopped" }],
    );

    expect(model.isLive).toBe(false);
    expect(model.counts).toEqual({ running: 0, done: 1, failed: 1, stopped: 1, interrupted: 0 });
    expect(model.allStopped).toBe(false);
    expect(model.rows[1]!.outcomeText).toBe("`pytest` is not installed (exit 127)");
    expect(model.rows[2]!.phase).toBe("stopped");
    expect(describeSubagentRunRow(model.rows[2]!, { nowMs: 0, allStopped: false })).toMatchObject({
      word: "Stopped",
      durationLabel: "21s",
      detail: { kind: "was-running", action: { label: "sleep 60" } },
    });
    expect(describeSubagentRunHeader(model, 0)).toEqual({
      title: "3 subagents",
      nestedLabel: null,
      segments: [
        { text: "1 done", tone: null },
        { text: "1 failed", tone: "failed" },
        { text: "1 stopped", tone: null },
      ],
      durationLabel: "21s",
    });
  });

  it("does not attribute a stopped outcome to the user without evidence", () => {
    const model = card(
      [
        { threadId: "a", rawStatus: "stopped" },
        { threadId: "b", rawStatus: "stopped" },
      ],
      [],
      [{ key: "a" }, { key: "b" }],
    );
    expect(model.allStopped).toBe(true);
    expect(describeSubagentRunHeader(model, 0).segments).toEqual([
      { text: "stopped", tone: null },
    ]);
    expect(describeSubagentRunRow(model.rows[0]!, { nowMs: 0, allStopped: true }).word).toBe(
      "Stopped",
    );
  });

  it("keeps a provider interruption distinct from a stopped subagent", () => {
    const model = card([{ threadId: "a", rawStatus: "interrupted" }], [], [{ key: "a" }]);
    expect(model.rows[0]!.phase).toBe("interrupted");
    expect(describeSubagentRunRow(model.rows[0]!, { nowMs: 0, allStopped: false }).word).toBe("Interrupted");
    expect(describeSubagentRunHeader(model, 0).segments).toEqual([{ text: "1 interrupted", tone: null }]);
  });

  it("nests subagents under the subagent that launched them", () => {
    const outerId = "subagent:parent:outer";
    const model = card(
      [
        { threadId: "outer", nickname: "Survey calc.py", statusLabel: "Running", isActive: true },
        { threadId: "readme", nickname: "Read README.md", statusLabel: "Completed" },
      ],
      [
        childThread(outerId, { session: { status: "running" } as SubagentRunThread["session"] }),
        childThread("subagent:parent:readme", {
          latestTurn: completedTurn(launchedAt, "2026-10-10T00:00:06.000Z"),
        }),
        childThread("subagent:parent:inner", {
          title: "Count lines in calc.py [general-purpose]",
          subagentNickname: "Count lines in calc.py",
          sourceThreadId: ThreadId.makeUnsafe(outerId),
          session: { status: "running" } as SubagentRunThread["session"],
        }),
      ],
      [{ key: "outer" }, { key: "readme" }],
    );

    expect(model.rows).toHaveLength(2);
    expect(model.nestedCount).toBe(1);
    expect(model.counts.running).toBe(2);
    const outer = model.rows[0]!;
    expect(outer.phase).toBe("waiting");
    expect(outer.nested.map((row) => row.item.primaryLabel)).toEqual(["Count lines in calc.py"]);
    expect(outer.nested[0]!.item.providerThreadId).toBe("inner");
    expect(describeSubagentRunRow(outer, { nowMs: 0, allStopped: false }).word).toBe(
      "Waiting for its subagent",
    );
    expect(describeSubagentRunHeader(model, Date.parse(launchedAt)).nestedLabel).toBe("+1 nested");
  });
});

describe("findLatestRunningSubagentRun", () => {
  it("points at the newest card that still has a subagent at work", () => {
    const folded = foldSubagentRunWorkEntries([
      spawn("old", "2026-10-10T00:00:00.000Z", [{ threadId: "x", isActive: true }], "turn-1"),
      spawn("new", "2026-10-10T00:01:00.000Z", [{ threadId: "y", rawStatus: "completed" }], "turn-2"),
    ]);
    expect(
      findLatestRunningSubagentRun({
        entries: folded,
        threads: [],
        parentThreadId: PARENT,
        liveTurnId: null,
      }),
    ).toEqual({
      entryId: "subagent-run:old",
      runningCount: 1,
    });
    expect(
      findLatestRunningSubagentRun({
        entries: [entry({ id: "plain" })],
        threads: [],
        parentThreadId: PARENT,
        liveTurnId: null,
      }),
    ).toBeNull();
  });
});

describe("firstLinePreview", () => {
  it("keeps the first meaningful line, without markdown markers", () => {
    expect(firstLinePreview("\n\n- **calc.py** has 5 lines\nsecond")).toBe("calc.py has 5 lines");
    expect(firstLinePreview("```\ncode\n```")).toBe("code");
    expect(firstLinePreview("   ")).toBeNull();
  });
});
