import { ProjectTaskId, ThreadId, type ProjectTask } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { partitionProjectFocusRows, rewriteThreadIdsAsMarkdownLinks } from "./projectPanel.logic";

function task(input: {
  id: string;
  title: string;
  status: "planned" | "running" | "done" | "cancelled";
  description?: string | null;
  archivedAt?: string | null;
  assignedThreadId?: string | null;
}) {
  return {
    id: ProjectTaskId.makeUnsafe(input.id),
    projectId: "project-1" as never,
    goalId: "goal-1" as never,
    title: input.title,
    description: input.description ?? null,
    acceptanceCriteria: null,
    status: input.status,
    dependsOnTaskIds: [],
    assignedThreadId: input.assignedThreadId ? ThreadId.makeUnsafe(input.assignedThreadId) : null,
    repairCount: 0,
    archivedAt: input.archivedAt ?? null,
    revision: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  } as ProjectTask;
}

describe("partitionProjectFocusRows", () => {
  it("splits open, done, and archived work", () => {
    const partitioned = partitionProjectFocusRows([
      task({
        id: "open-1",
        title: "Write auth skill",
        status: "running",
        description: "Needs GitHub MCP auth",
        assignedThreadId: "thread-open",
      }),
      task({ id: "done-1", title: "Test emulator", status: "done" }),
      task({
        id: "arch-1",
        title: "Old attempt",
        status: "cancelled",
        archivedAt: "2026-09-16T00:00:00.000Z",
      }),
    ]);
    expect(partitioned.open.map((row) => row.title)).toEqual(["Write auth skill"]);
    expect(partitioned.open[0]?.detail).toBe("Needs GitHub MCP auth");
    expect(partitioned.done.map((row) => row.title)).toEqual(["Test emulator"]);
    expect(partitioned.archived.map((row) => row.title)).toEqual(["Old attempt"]);
  });
});

describe("rewriteThreadIdsAsMarkdownLinks", () => {
  it("turns known thread ids into markdown links", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(
      rewriteThreadIdsAsMarkdownLinks(`Started ${threadId} for the skill.`, [
        { id: threadId, title: "Write auth skill" },
      ]),
    ).toBe(
      "Started [Write auth skill](thread://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee) for the skill.",
    );
  });
});
