import { CheckpointRef, MessageId, OrchestrationProposedPlanId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildTurnDiffSummaryByAssistantMessageId,
  computeMessageDurationStart,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveTerminalAssistantMessageIds,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";
import type { TurnDiffSummary } from "../../types";

function makeSummary(
  overrides: Omit<Partial<TurnDiffSummary>, "turnId"> & { turnId: string },
): TurnDiffSummary {
  const { turnId, ...rest } = overrides;
  return {
    turnId: TurnId.makeUnsafe(turnId),
    status: "ready",
    completedAt: "2026-01-01T00:00:10Z",
    files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    checkpointRef: CheckpointRef.makeUnsafe(`checkpoint-${turnId}`),
    checkpointTurnCount: 1,
    assistantMessageId: null,
    ...rest,
  } as TurnDiffSummary;
}

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("computeStableMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;

  const emptyStableRows = (): StableMessagesTimelineRowsState => ({
    byId: new Map(),
    result: [],
  });

  it("replaces work rows when later tool metadata adds visible details", () => {
    const firstRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "activity-read",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Read",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolTitle: "Read",
          },
        ],
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "activity-read",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Read",
            tone: "tool",
            itemType: "dynamic_tool_call",
            toolTitle: "Read",
            detail: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:12",
            changedFiles: ["apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts"],
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces work rows when automation card fields are added", () => {
    const firstRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-automation",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "automation-created",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Created automation",
            tone: "info",
          },
        ],
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-automation",
        createdAt: "2026-05-09T10:00:00.000Z",
        groupedEntries: [
          {
            id: "automation-created",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Created automation",
            tone: "info",
            automation: {
              id: "automation-7",
              name: "Watch Synara PR 231",
              cadenceLabel: "Every 5m",
            },
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces assistant rows when inline tool metadata becomes richer", () => {
    const assistantMessage = {
      id: MessageId.makeUnsafe("assistant-1"),
      role: "assistant" as const,
      text: "Working on it.",
      createdAt: "2026-05-09T10:00:01.000Z",
      streaming: true,
    };
    const firstRows: MessageTimelineRow[] = [
      {
        kind: "message",
        id: "assistant-1",
        createdAt: "2026-05-09T10:00:01.000Z",
        message: assistantMessage,
        inlineWorkEntries: [
          {
            id: "activity-command",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Ran",
          },
        ],
        inlineWorkGroupId: "activity-command",
        durationStart: "2026-05-09T10:00:01.000Z",
        showAssistantCopyButton: false,
        assistantCopyStreaming: true,
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessageTimelineRow[] = [
      {
        ...firstRows[0]!,
        inlineWorkEntries: [
          {
            id: "activity-command",
            createdAt: "2026-05-09T10:00:00.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Ran",
            command: 'git grep -n "model.rerouted"',
            rawCommand: "/bin/zsh -lc 'git grep -n \"model.rerouted\"'",
            requestKind: "command",
          },
        ],
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });
});

describe("deriveTerminalAssistantMessageIds", () => {
  it("keeps only the latest assistant message in a user-visible response segment", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z", turnId: "t1" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z", turnId: "t1" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:03Z", turnId: "t2" },
      ]),
    ).toEqual(new Set(["a3"]));
  });

  it("treats assistant messages without turn ids as one response per user boundary", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z" },
        { id: "u2", role: "user", createdAt: "2026-01-01T00:00:03Z" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toEqual(new Set(["a2", "a3"]));
  });
});

describe("buildTurnDiffSummaryByAssistantMessageId", () => {
  it("attaches each summary to the terminal assistant message of its response segment", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" }), makeSummary({ turnId: "turn-2" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-1"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        {
          id: MessageId.makeUnsafe("a-turn-2"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-2"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-2"))?.turnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(result.has(MessageId.makeUnsafe("a-turn-1"))).toBe(false);
    expect(result.size).toBe(1);
  });

  it("moves an earlier mini-turn diff to a later final answer in the same response segment", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-files" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-final"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-final"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-final"))?.turnId).toBe(
      TurnId.makeUnsafe("turn-files"),
    );
    expect(result.has(MessageId.makeUnsafe("a-files"))).toBe(false);
  });

  it("keeps files from multiple mini-turn summaries on the final answer", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [
        makeSummary({
          turnId: "turn-files",
          files: [{ path: "a.ts", additions: 1, deletions: 0 }],
        }),
        makeSummary({
          turnId: "turn-final",
          files: [{ path: "b.ts", additions: 0, deletions: 1 }],
        }),
      ],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-files"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-files"),
        },
        {
          id: MessageId.makeUnsafe("a-final"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-final"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-final"))?.files.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("keeps separate cards for response segments split by user messages", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" }), makeSummary({ turnId: "turn-2" })],
      messages: [
        { id: MessageId.makeUnsafe("u-1"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-1"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        { id: MessageId.makeUnsafe("u-2"), role: "user", turnId: null },
        {
          id: MessageId.makeUnsafe("a-turn-2"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-2"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-1"))?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(result.get(MessageId.makeUnsafe("a-turn-2"))?.turnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(result.size).toBe(2);
  });

  it("does not leak a summary to an unrelated message even when ids look similar", () => {
    // Regression for the "Files changed on wrong thread" bug: before the fix,
    // the server synthesized `assistant:<turnId>` ids that could collide with
    // the real message id of a different turn. Anchoring by the matching turn's
    // response segment prevents the card from attaching to unrelated rows.
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-files-changed" })],
      messages: [
        {
          id: MessageId.makeUnsafe("a-unrelated"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-no-changes"),
        },
      ],
    });

    expect(result.size).toBe(0);
  });

  it("ignores summaries for turns that have no rendered assistant message yet", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [],
    });

    expect(result.size).toBe(0);
  });

  it("attaches the summary to the LAST assistant message of a turn when multiple exist", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [
        {
          id: MessageId.makeUnsafe("a-turn-1-first"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
        {
          id: MessageId.makeUnsafe("a-turn-1-last"),
          role: "assistant",
          turnId: TurnId.makeUnsafe("turn-1"),
        },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-1-last"))?.turnId).toBe(
      TurnId.makeUnsafe("turn-1"),
    );
    expect(result.has(MessageId.makeUnsafe("a-turn-1-first"))).toBe(false);
    expect(result.size).toBe(1);
  });

  it("returns an empty map when there are no summaries", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [],
      messages: [
        { id: MessageId.makeUnsafe("a-1"), role: "assistant", turnId: TurnId.makeUnsafe("turn-1") },
      ],
    });

    expect(result.size).toBe(0);
  });

  it("ignores assistant messages without a turnId", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      messages: [{ id: MessageId.makeUnsafe("a-nullturn"), role: "assistant", turnId: null }],
    });

    expect(result.size).toBe(0);
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("shows copy only for non-empty settled assistant text", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: "Hello", visible: true });
  });

  it("hides copy while the active assistant response is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: true,
      }),
    ).toEqual({ text: "Hello", visible: false });
  });

  it("hides copy for empty responses", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "   ",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: null, visible: false });
  });
});

describe("deriveMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;

  const baseInput = {
    isWorking: false,
    activeTurnStartedAt: null as string | null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };

  const userEntry = (id: string, createdAt: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text: "ask",
      createdAt,
      streaming: false,
    },
  });

  const assistantEntry = (
    id: string,
    createdAt: string,
    opts: { turnId?: string; text?: string; streaming?: boolean; completedAt?: string },
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: opts.text ?? "reply",
      createdAt,
      streaming: opts.streaming ?? false,
      ...(opts.turnId ? { turnId: TurnId.makeUnsafe(opts.turnId) } : {}),
      ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    },
  });

  const workEntry = (
    id: string,
    createdAt: string,
    label: string,
    tone: "thinking" | "tool" | "info" | "error" = "tool",
  ): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label, tone },
  });

  const proposedPlanEntry = (id: string, createdAt: string, turnId: string): TimelineEntry => ({
    id: `entry-${id}`,
    kind: "proposed-plan",
    createdAt,
    proposedPlan: {
      id: OrchestrationProposedPlanId.makeUnsafe(id),
      turnId: TurnId.makeUnsafe(turnId),
      planMarkdown: "# Plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt,
      updatedAt: createdAt,
    },
  });

  const messageRow = (rows: MessagesTimelineRow[], id: string): MessageTimelineRow | undefined =>
    rows.find(
      (row): row is MessageTimelineRow =>
        row.kind === "message" && row.message.id === MessageId.makeUnsafe(id),
    );

  const collapsedSignature = (row: MessageTimelineRow): string[] =>
    (row.collapsedTurnItems ?? []).map((item) => `${item.kind}:${String(item.id)}`);

  it("folds a settled turn's narration and work into one collapsed group on the terminal message", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "Looking into it",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "Almost there",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        workEntry("w2", "2026-01-01T00:00:04Z", "tool 2"),
        assistantEntry("a3", "2026-01-01T00:00:05Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:06Z",
        }),
      ],
    });

    const visibleMessageIds = rows
      .filter((row): row is MessageTimelineRow => row.kind === "message")
      .map((row) => String(row.message.id));
    expect(visibleMessageIds).toEqual(["u1", "a3"]);

    const terminal = messageRow(rows, "a3");
    expect(terminal).toBeDefined();
    expect(collapsedSignature(terminal!)).toEqual([
      "narration:a1",
      "work:w1",
      "narration:a2",
      "work:w2",
    ]);
    expect(terminal!.inlineWorkEntries).toBeUndefined();
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("keeps the live turn expanded instead of collapsing while it streams", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "Looking into it",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a3", "2026-01-01T00:00:05Z", {
          turnId: "t1",
          text: "still going",
          streaming: true,
        }),
      ],
    });

    expect(messageRow(rows, "a1")).toBeDefined();
    const terminal = messageRow(rows, "a3");
    expect(terminal).toBeDefined();
    expect(terminal!.collapsedTurnItems).toBeUndefined();
  });

  it("keeps pre-existing tool work above the new live narration text", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "I will inspect it.",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "read files"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "Here is what I found so far.",
          streaming: true,
        }),
        workEntry("w2", "2026-01-01T00:00:04Z", "search files"),
      ],
    });

    const streamingNarration = messageRow(rows, "a2");

    expect(streamingNarration?.leadingWorkEntries?.map((entry) => entry.id)).toEqual(["w1"]);
    expect(streamingNarration?.leadingWorkGroupId).toBe("entry-w1");
    expect(streamingNarration?.inlineWorkEntries?.map((entry) => entry.id)).toEqual(["w2"]);
    expect(streamingNarration?.inlineWorkGroupId).toBe("entry-w2");
  });

  it("keeps a just-settled tail assistant expanded when the active turn id is briefly unavailable", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        workEntry("w1", "2026-01-01T00:00:01Z", "tool 1"),
        assistantEntry("a1", "2026-01-01T00:00:02Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:03Z",
        }),
      ],
    });

    const terminal = messageRow(rows, "a1");
    expect(terminal).toBeDefined();
    expect(terminal!.leadingWorkEntries?.map((entry) => entry.id)).toEqual(["w1"]);
    expect(terminal!.inlineWorkEntries).toBeUndefined();
    expect(terminal!.collapsedTurnItems).toBeUndefined();
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("collapses an older settled turn when a follow-up user message is waiting for output", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnStartedAt: "2026-01-01T00:00:05Z",
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        workEntry("w1", "2026-01-01T00:00:01Z", "tool 1"),
        assistantEntry("a1", "2026-01-01T00:00:02Z", {
          turnId: "t1",
          text: "All done",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        userEntry("u2", "2026-01-01T00:00:05Z"),
      ],
    });

    const previousAssistant = messageRow(rows, "a1");
    expect(previousAssistant).toBeDefined();
    expect(collapsedSignature(previousAssistant!)).toEqual(["work:w1"]);
    expect(previousAssistant!.inlineWorkEntries).toBeUndefined();
    expect(messageRow(rows, "u2")).toBeDefined();
    expect(rows.some((row) => row.kind === "work")).toBe(false);
  });

  it("collapses adjacent provider mini-turns into the same user-visible response", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "first preamble",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        assistantEntry("a2", "2026-01-01T00:00:03Z", {
          turnId: "t1",
          text: "first final",
          completedAt: "2026-01-01T00:00:03Z",
        }),
        assistantEntry("a3", "2026-01-01T00:00:04Z", {
          turnId: "t2",
          text: "second preamble",
          completedAt: "2026-01-01T00:00:04Z",
        }),
        workEntry("w2", "2026-01-01T00:00:05Z", "tool 2"),
        assistantEntry("a4", "2026-01-01T00:00:06Z", {
          turnId: "t2",
          text: "second final",
          completedAt: "2026-01-01T00:00:06Z",
        }),
      ],
    });

    const visibleMessageIds = rows
      .filter((row): row is MessageTimelineRow => row.kind === "message")
      .map((row) => String(row.message.id));
    expect(visibleMessageIds).toEqual(["u1", "a4"]);

    expect(collapsedSignature(messageRow(rows, "a4")!)).toEqual([
      "narration:a1",
      "work:w1",
      "narration:a2",
      "narration:a3",
      "work:w2",
    ]);
  });

  it("collapses turn work across an intervening proposed plan card", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        userEntry("u1", "2026-01-01T00:00:00Z"),
        assistantEntry("a1", "2026-01-01T00:00:01Z", {
          turnId: "t1",
          text: "I have a plan",
          completedAt: "2026-01-01T00:00:01Z",
        }),
        workEntry("w1", "2026-01-01T00:00:02Z", "tool 1"),
        proposedPlanEntry("plan-1", "2026-01-01T00:00:03Z", "t1"),
        assistantEntry("a2", "2026-01-01T00:00:04Z", {
          turnId: "t1",
          text: "final",
          completedAt: "2026-01-01T00:00:05Z",
        }),
      ],
    });

    expect(rows.some((row) => row.kind === "proposed-plan")).toBe(true);
    expect(collapsedSignature(messageRow(rows, "a2")!)).toEqual(["narration:a1", "work:w1"]);
  });
});
