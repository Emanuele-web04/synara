import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  collectBackgroundThreadActivityItems,
  getThreadIdsNeedingBackgroundDetail,
  resolveBackgroundThreadActivityKind,
} from "./backgroundThreadActivity";
import type { SidebarThreadSummary } from "./types";

function makeThread(
  patch: Omit<Partial<SidebarThreadSummary>, "id" | "title"> & { id: string; title?: string },
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(patch.id),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: patch.title ?? patch.id,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...patch,
    id: ThreadId.makeUnsafe(patch.id),
  };
}

describe("backgroundThreadActivity", () => {
  it("keeps running threads eligible for background detail subscriptions", () => {
    const runningThread = makeThread({
      id: "thread-running",
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: TurnId.makeUnsafe("turn-running"),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        orchestrationStatus: "running",
      },
    });

    expect(resolveBackgroundThreadActivityKind(runningThread)).toBe("working");
    expect(getThreadIdsNeedingBackgroundDetail([runningThread])).toEqual([runningThread.id]);
  });

  it("shows only non-visible active threads in the background dock list", () => {
    const visibleRunningThread = makeThread({
      id: "thread-visible",
      hasLiveTailWork: true,
    });
    const backgroundInputThread = makeThread({
      id: "thread-input",
      title: "Needs answer",
      hasPendingUserInput: true,
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    const idleThread = makeThread({
      id: "thread-idle",
      updatedAt: "2026-01-01T00:03:00.000Z",
    });

    expect(
      collectBackgroundThreadActivityItems({
        threads: [visibleRunningThread, backgroundInputThread, idleThread],
        visibleThreadIds: new Set([visibleRunningThread.id]),
      }),
    ).toEqual([
      {
        threadId: backgroundInputThread.id,
        projectId: backgroundInputThread.projectId,
        title: "Needs answer",
        kind: "input-needed",
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
    ]);
  });
});
