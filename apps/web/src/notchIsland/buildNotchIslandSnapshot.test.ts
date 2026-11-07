import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";

import type { InboxThreadGroups } from "../components/inbox/inbox.logic";
import type { SidebarThreadSummary, ThreadSession } from "../types";
import { buildNotchIslandSnapshot, NOTCH_ISLAND_ROW_LIMIT } from "./buildNotchIslandSnapshot";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-09-30T08:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  } satisfies SidebarThreadSummary;
}

const projects = new Map([
  ["project-1", { kind: "project" as const, name: "synara", folderName: "synara" }],
]);

describe("buildNotchIslandSnapshot", () => {
  it("counts every group and lists what needs you first", () => {
    const groups: InboxThreadGroups = {
      needsYou: [
        { kind: "approval", thread: thread("approval") },
        { kind: "input", thread: thread("question") },
      ],
      working: [
        thread("running", {
          session: { provider: "claudeAgent", status: "running" } as ThreadSession,
        }),
      ],
      finished: [thread("finished")],
      failed: [thread("failed")],
    };

    const snapshot = buildNotchIslandSnapshot(groups, projects);

    expect(snapshot).toMatchObject({ needsYou: 2, working: 1, done: 1, failed: 1 });
    expect(snapshot.rows.map((row) => [row.threadId, row.state])).toEqual([
      ["approval", "approval"],
      ["question", "input"],
      ["running", "working"],
      ["failed", "failed"],
    ]);
    expect(snapshot.rows[0]).toMatchObject({ project: "synara", provider: "codex" });
    // The live session's provider wins over the configured model.
    expect(snapshot.rows[2]?.provider).toBe("claudeAgent");
  });

  it("caps the rows but not the counts", () => {
    const working = Array.from({ length: 7 }, (_, index) => thread(`w-${index}`));
    const snapshot = buildNotchIslandSnapshot(
      { needsYou: [], working, finished: [], failed: [] },
      projects,
    );
    expect(snapshot.working).toBe(7);
    expect(snapshot.rows).toHaveLength(NOTCH_ISLAND_ROW_LIMIT);
  });

  it("labels project-less chats as Synara, like the sidebar", () => {
    const snapshot = buildNotchIslandSnapshot(
      {
        needsYou: [],
        working: [thread("home", { projectId: ProjectId.makeUnsafe("home") })],
        finished: [],
        failed: [],
      },
      projects,
    );
    expect(snapshot.rows[0]?.project).toBe("Synara");
  });
});
