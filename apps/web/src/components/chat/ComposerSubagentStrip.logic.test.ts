// FILE: ComposerSubagentStrip.logic.test.ts
// Purpose: Locks composer subagent strip row derivation to live-turn scoping,
// snapshot merging, and retire-once-finished behavior.
// Layer: Web chat composer tests
// Depends on: deriveComposerSubagentStripItems

import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries, type WorkLogEntry, type WorkLogSubagent } from "../../session-logic";
import type { Thread } from "../../types";
import { enrichSubagentWorkEntries } from "../ChatView.logic";
import { localSubagentThreadId } from "../ChatView.selectors";
import { deriveComposerSubagentStripItems } from "./ComposerSubagentStrip.logic";

function workEntry(
  overrides: Partial<Omit<WorkLogEntry, "turnId">> & { id: string; turnId?: string | null },
): WorkLogEntry {
  const { turnId, ...rest } = overrides;
  return {
    createdAt: "2026-07-14T00:00:00.000Z",
    label: "Ran subagents",
    tone: "tool",
    turnId: turnId ? TurnId.makeUnsafe(turnId) : null,
    ...rest,
  };
}

function subagent(overrides: Partial<WorkLogSubagent> & { threadId: string }): WorkLogSubagent {
  return overrides;
}

describe("deriveComposerSubagentStripItems", () => {
  it("returns no rows when the work log has no subagents", () => {
    expect(
      deriveComposerSubagentStripItems({
        workEntries: [workEntry({ id: "entry-1", turnId: "turn-1" })],
        liveTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toEqual([]);
  });

  it("scopes rows to the live turn when it spawned subagents", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [subagent({ threadId: "old-agent", nickname: "Ada", rawStatus: "running" })],
        }),
        workEntry({
          id: "entry-2",
          turnId: "turn-2",
          subagents: [
            subagent({
              threadId: "sub-1",
              nickname: "Blue",
              role: "reviewer",
              rawStatus: "running",
              isActive: true,
            }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-2"),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      threadId: "sub-1",
      primaryLabel: "Blue",
      role: "reviewer",
      fullLabel: "Blue [reviewer]",
      statusKind: "running",
      isActive: true,
    });
  });

  it("merges snapshots of one subagent, keeping identity while the latest status wins", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({
              threadId: "sub-1",
              agentId: "agent-1",
              nickname: "Ada",
              role: "builder",
              model: "opus-4.5",
              rawStatus: "running",
              isActive: true,
            }),
          ],
        }),
        workEntry({
          id: "entry-2",
          turnId: "turn-1",
          subagents: [
            subagent({
              threadId: "sub-1",
              agentId: "agent-1",
              resolvedThreadId: "subagent:parent:sub-1",
              rawStatus: "completed",
            }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      threadId: "subagent:parent:sub-1",
      primaryLabel: "Ada",
      role: "builder",
      statusLabel: "Completed",
      statusKind: "completed",
      isActive: false,
    });
    expect(items[0]?.modelLabel).toBeDefined();
  });

  it("keeps the latest prior set visible only while a subagent still works", () => {
    const entries = (status: string) => [
      workEntry({
        id: "entry-1",
        turnId: "turn-1",
        subagents: [
          subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: status }),
          subagent({ threadId: "sub-2", nickname: "Blue", rawStatus: "completed" }),
        ],
      }),
    ];

    const stillRunning = deriveComposerSubagentStripItems({
      workEntries: entries("running"),
      liveTurnId: null,
    });
    expect(stillRunning.map((item) => item.primaryLabel)).toEqual(["Ada", "Blue"]);

    expect(
      deriveComposerSubagentStripItems({
        workEntries: entries("completed"),
        liveTurnId: null,
      }),
    ).toEqual([]);
  });

  it("appends the worker-tier effort to the model label", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({
              threadId: "sub-1",
              nickname: "Ada",
              model: "sonnet",
              effort: "high",
              rawStatus: "running",
              isActive: true,
            }),
            subagent({
              threadId: "sub-2",
              nickname: "Blue",
              effort: "low",
              rawStatus: "running",
              isActive: true,
            }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
    });

    expect(items[0]?.modelLabel).toBe("Sonnet · high");
    // No model hint: the effort still reads on its own.
    expect(items[1]?.modelLabel).toBe("low");
  });

  it("marks rows background from spawn hints and confirmed backgrounded tool use ids", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({
              threadId: "sub-fg",
              providerThreadId: "sub-fg",
              nickname: "Ada",
              rawStatus: "running",
              isActive: true,
            }),
            subagent({
              threadId: "sub-bg-spawn",
              providerThreadId: "sub-bg-spawn",
              nickname: "Blue",
              background: true,
              rawStatus: "running",
              isActive: true,
            }),
            subagent({
              threadId: "sub-bg-patch",
              providerThreadId: "sub-bg-patch",
              nickname: "Cleo",
              rawStatus: "running",
              isActive: true,
            }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-1"),
      backgroundedProviderThreadIds: new Set(["sub-bg-patch"]),
    });

    expect(items.map((item) => [item.providerThreadId, item.isBackground])).toEqual([
      ["sub-fg", false],
      ["sub-bg-spawn", true],
      ["sub-bg-patch", true],
    ]);
  });

  it("falls back to prior subagents when the live turn spawned none", () => {
    const items = deriveComposerSubagentStripItems({
      workEntries: [
        workEntry({
          id: "entry-1",
          turnId: "turn-1",
          subagents: [
            subagent({ threadId: "sub-1", nickname: "Ada", rawStatus: "running", isActive: true }),
          ],
        }),
      ],
      liveTurnId: TurnId.makeUnsafe("turn-2"),
    });

    expect(items.map((item) => item.primaryLabel)).toEqual(["Ada"]);
  });

  it("derives a strip row end-to-end from a routed collab activity omitted by the timeline", () => {
    const parentThreadId = ThreadId.makeUnsafe("thread-1");
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("routed-agent-update"),
        createdAt: "2026-07-14T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Subagent task",
        tone: "tool",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolCallId: "toolu_x",
            callId: "toolu_x",
            toolName: "Agent",
            input: {},
            receiverThreadId: "toolu_x",
          },
        },
      },
    ];

    // Timeline entries omit the routed activity; the strip source must not.
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
    const stripEntries = deriveWorkLogEntries(activities, undefined, {
      includeRoutedSubagentActivities: true,
    });

    const subagentThread: Thread = {
      id: localSubagentThreadId(parentThreadId, "toolu_x"),
      codexThreadId: null,
      projectId: "project-1" as Thread["projectId"],
      title: "Subagent task",
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: {
        provider: "claudeAgent",
        status: "running",
        createdAt: "2026-07-14T00:00:01.000Z",
        updatedAt: "2026-07-14T00:00:01.000Z",
        orchestrationStatus: "running",
      },
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-07-14T00:00:01.000Z",
      latestTurn: null,
      parentThreadId,
      turnDiffSummaries: [],
      activities: [],
      branch: null,
      worktreePath: null,
    };
    const enriched = enrichSubagentWorkEntries(stripEntries, [subagentThread], parentThreadId);

    // Background case: parent turn already settled (liveTurnId null) while the
    // subagent keeps running.
    const items = deriveComposerSubagentStripItems({
      workEntries: enriched,
      liveTurnId: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      threadId: subagentThread.id,
      providerThreadId: "toolu_x",
      statusKind: "running",
      isActive: true,
    });
  });
});
