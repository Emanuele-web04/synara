// FILE: ComposerSubagentStrip.logic.test.ts
// Purpose: Locks composer subagent strip row derivation to live-turn scoping,
// snapshot merging, and retire-once-finished behavior.
// Layer: Web chat composer tests
// Depends on: deriveComposerSubagentStripItems

import { TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry, WorkLogSubagent } from "../../session-logic";
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
});
