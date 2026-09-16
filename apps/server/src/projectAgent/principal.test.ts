import { ProjectId, ProjectTaskId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { canAcceptTask, canStartGoal, isCoordinatorPrincipal } from "./principal";

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
});
