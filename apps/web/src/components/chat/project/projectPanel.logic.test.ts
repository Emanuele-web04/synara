import { ProjectTaskId, ThreadId, type ProjectTask } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { INITIAL_PROJECT_DIGEST_SUMMARY } from "@synara/shared/projectAgent";

import {
  mergeProjectFocusRows,
  partitionProjectFocusRows,
  projectThreadIndexFocusRows,
  rewriteThreadIdsAsMarkdownLinks,
  sanitizeProjectDigestSummary,
} from "./projectPanel.logic";

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

describe("sanitizeProjectDigestSummary", () => {
  it("hides leftover start-a-goal copy in Focus", () => {
    expect(
      sanitizeProjectDigestSummary(
        "Coordinator is configured. Start a goal to begin bounded coordination.",
      ),
    ).toBe(INITIAL_PROJECT_DIGEST_SUMMARY);
  });
});

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

describe("projectThreadIndexFocusRows", () => {
  it("lists worker threads and hides the coordinator", () => {
    const coordinatorId = ThreadId.makeUnsafe("thread-coordinator");
    const workerId = ThreadId.makeUnsafe("thread-worker");
    const rows = projectThreadIndexFocusRows({
      coordinatorThreadId: coordinatorId,
      titlesById: new Map([[workerId, "Sample map Focus"]]),
      threads: [
        {
          projectId: "project-1" as never,
          threadId: coordinatorId,
          excluded: false,
          archived: false,
          summaryStatus: "covered",
          lastUpdatedAt: "2026-09-17T00:00:00.000Z",
          lastSummarizedAt: null,
        },
        {
          projectId: "project-1" as never,
          threadId: workerId,
          excluded: false,
          archived: false,
          summaryStatus: "pending",
          lastUpdatedAt: "2026-09-17T00:00:00.000Z",
          lastSummarizedAt: null,
        },
      ],
    });
    expect(rows.open.map((row) => row.title)).toEqual(["Sample map Focus"]);
    expect(
      mergeProjectFocusRows(partitionProjectFocusRows([]), rows).open.map((row) => row.title),
    ).toEqual(["Sample map Focus"]);
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

  it("resolves synara://thread links whose target is a known title with spaces", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const threads = [{ id: threadId, title: "Mars public opinion research" }];
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars public opinion research).",
        threads,
      ),
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
    // The same link arrives %-encoded when the assistant encoded the target.
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars%20public%20opinion%20research).",
        threads,
      ),
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
  });

  it("resolves synara://thread links whose target is a known thread id", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(
      rewriteThreadIdsAsMarkdownLinks(`Done: [report](synara://thread/${threadId}).`, [
        { id: threadId, title: "Mars public opinion research" },
      ]),
      // The id pass canonicalizes the label to the known thread title.
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
  });

  it("keeps unknown synara://thread targets parseable by encoding the spaces", () => {
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars public opinion research).",
        [],
      ),
    ).toBe(
      "Done: [Mars public opinion research](synara://thread/Mars%20public%20opinion%20research).",
    );
  });
});
