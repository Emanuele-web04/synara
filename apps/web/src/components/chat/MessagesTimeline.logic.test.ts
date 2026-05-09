import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildTurnDiffSummaryByAssistantMessageId,
  computeMessageDurationStart,
  computeStableMessagesTimelineRows,
  deriveTerminalAssistantMessageIds,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
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
            changedFiles: [
              "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
            ],
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
    const firstRows: MessagesTimelineRow[] = [
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
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
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
            command: "git grep -n \"model.rerouted\"",
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
  it("keeps only the latest assistant message for a turn", () => {
    expect(
      deriveTerminalAssistantMessageIds([
        { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01Z", turnId: "t1" },
        { id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z", turnId: "t1" },
        { id: "a3", role: "assistant", createdAt: "2026-01-01T00:00:03Z", turnId: "t2" },
      ]),
    ).toEqual(new Set(["a2", "a3"]));
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
  it("attaches each summary to the terminal assistant message of its turn by turnId", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" }), makeSummary({ turnId: "turn-2" })],
      assistantMessages: [
        { id: MessageId.makeUnsafe("a-turn-1"), turnId: TurnId.makeUnsafe("turn-1") },
        { id: MessageId.makeUnsafe("a-turn-2"), turnId: TurnId.makeUnsafe("turn-2") },
      ],
    });

    expect(result.get(MessageId.makeUnsafe("a-turn-1"))?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(result.get(MessageId.makeUnsafe("a-turn-2"))?.turnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(result.size).toBe(2);
  });

  it("does not leak a summary to an unrelated message even when ids look similar", () => {
    // Regression for the "Files changed on wrong thread" bug: before the fix,
    // the server synthesized `assistant:<turnId>` ids that could collide with
    // the real message id of a different turn. With the new turnId-scoped
    // lookup, collisions cannot attach the card to the wrong message.
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-files-changed" })],
      assistantMessages: [
        { id: MessageId.makeUnsafe("a-unrelated"), turnId: TurnId.makeUnsafe("turn-no-changes") },
      ],
    });

    expect(result.size).toBe(0);
  });

  it("ignores summaries for turns that have no rendered assistant message yet", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      assistantMessages: [],
    });

    expect(result.size).toBe(0);
  });

  it("attaches the summary to the LAST assistant message of a turn when multiple exist", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      assistantMessages: [
        { id: MessageId.makeUnsafe("a-turn-1-first"), turnId: TurnId.makeUnsafe("turn-1") },
        { id: MessageId.makeUnsafe("a-turn-1-last"), turnId: TurnId.makeUnsafe("turn-1") },
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
      assistantMessages: [{ id: MessageId.makeUnsafe("a-1"), turnId: TurnId.makeUnsafe("turn-1") }],
    });

    expect(result.size).toBe(0);
  });

  it("ignores assistant messages without a turnId", () => {
    const result = buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [makeSummary({ turnId: "turn-1" })],
      assistantMessages: [{ id: MessageId.makeUnsafe("a-nullturn"), turnId: null }],
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
