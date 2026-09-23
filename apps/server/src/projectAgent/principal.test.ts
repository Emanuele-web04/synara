import { ProjectId, ProjectTaskId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  canAcceptTask,
  canStartGoal,
  canWriteUserOwnedDocuments,
  coordinatorStatusFromGoal,
  isCoordinatorPrincipal,
  projectAgentSummariesForPrincipal,
} from "./principal";

const projectId = ProjectId.makeUnsafe("project-1");

describe("project agent principal", () => {
  it("allows only the user to start a goal", () => {
    expect(canStartGoal({ kind: "user" })).toBe(true);
    expect(
      canStartGoal({
        kind: "coordinator",
        threadId: ThreadId.makeUnsafe("t1"),
        projectId,
      }),
    ).toBe(false);
    expect(
      canStartGoal({
        kind: "worker",
        threadId: ThreadId.makeUnsafe("t2"),
        projectId,
        taskId: ProjectTaskId.makeUnsafe("task-1"),
      }),
    ).toBe(false);
  });

  it("allows coordinator or user to accept a task, not a worker", () => {
    expect(canAcceptTask({ kind: "user" }, projectId)).toBe(true);
    expect(
      canAcceptTask(
        { kind: "coordinator", threadId: ThreadId.makeUnsafe("t1"), projectId },
        projectId,
      ),
    ).toBe(true);
    expect(
      canAcceptTask(
        {
          kind: "worker",
          threadId: ThreadId.makeUnsafe("t2"),
          projectId,
          taskId: ProjectTaskId.makeUnsafe("task-1"),
        },
        projectId,
      ),
    ).toBe(false);
    expect(
      isCoordinatorPrincipal(
        { kind: "coordinator", threadId: ThreadId.makeUnsafe("t1"), projectId },
        ProjectId.makeUnsafe("other"),
      ),
    ).toBe(false);
  });

  it("does not treat unmanaged provider threads as the user", () => {
    const unmanaged = {
      kind: "unmanaged" as const,
      threadId: ThreadId.makeUnsafe("thread-unmanaged"),
      projectId,
    };
    expect(canStartGoal(unmanaged)).toBe(false);
    expect(canWriteUserOwnedDocuments(unmanaged)).toBe(false);
    expect(canWriteUserOwnedDocuments({ kind: "user" })).toBe(true);
  });

  it("keeps unmanaged MCP callers from seeing other project agent summaries", () => {
    const own = ProjectId.makeUnsafe("project-own");
    const other = ProjectId.makeUnsafe("project-other");
    const summaries = [
      {
        projectId: own,
        configured: true,
        coordinatorName: "Own Coordinator",
        coordinatorThreadId: ThreadId.makeUnsafe("thread-own"),
        coordinatorIcon: null,
        coordinatorColor: null,
        coordinatorStatus: "idle" as const,
        revision: 1,
      },
      {
        projectId: other,
        configured: true,
        coordinatorName: "Other Coordinator",
        coordinatorThreadId: ThreadId.makeUnsafe("thread-other"),
        coordinatorIcon: null,
        coordinatorColor: null,
        coordinatorStatus: "running" as const,
        revision: 2,
      },
    ];
    const visible = projectAgentSummariesForPrincipal(summaries, {
      kind: "unmanaged",
      threadId: ThreadId.makeUnsafe("thread-mcp"),
      projectId: own,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.projectId).toBe(own);
    expect(projectAgentSummariesForPrincipal(summaries, { kind: "user" })).toHaveLength(2);
  });

  it("maps an active goal to running coordinator status", () => {
    expect(coordinatorStatusFromGoal(false, null)).toBe("unconfigured");
    expect(coordinatorStatusFromGoal(true, null)).toBe("idle");
    expect(coordinatorStatusFromGoal(true, "active")).toBe("running");
    expect(coordinatorStatusFromGoal(true, "paused")).toBe("paused");
  });
});
