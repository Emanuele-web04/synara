import type { ExternalMcpCapability } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildExternalMcpOverviewNextSteps, buildExternalMcpOverviewProjects } from "./overview.ts";

const project = {
  id: "project-allowed",
  title: "Allowed",
  workspaceRoot: "/tmp/allowed",
};

interface TestThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly latestTurn: { readonly state: string } | null;
}

function thread(index: number, overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: `thread-${index}`,
    projectId: project.id,
    title: `Thread ${index}`,
    updatedAt: `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    archivedAt: null,
    latestTurn: index === 6 ? { state: "running" } : null,
    ...overrides,
  };
}

describe("external MCP overview", () => {
  it("groups allowed active threads once and returns only the five most recent", () => {
    const projects = buildExternalMcpOverviewProjects({
      projects: [project, { id: "project-denied", title: "Denied", workspaceRoot: "/tmp/denied" }],
      threads: [
        ...Array.from({ length: 6 }, (_, index) => thread(index + 1)),
        thread(7, { archivedAt: "2026-07-08T00:00:00.000Z" }),
        thread(8, { projectId: "project-denied" }),
      ],
      allowedProjectIds: new Set([project.id]),
      includeThreadMetadata: true,
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectId: project.id,
      threads: { total: 6, active: 1 },
    });
    expect(projects[0]?.recentThreads?.map((item) => item.threadId)).toEqual([
      "thread-6",
      "thread-5",
      "thread-4",
      "thread-3",
      "thread-2",
    ]);
  });

  it("omits thread metadata when the integration cannot read project tasks", () => {
    const projects = buildExternalMcpOverviewProjects({
      projects: [project],
      threads: [thread(1)],
      allowedProjectIds: new Set([project.id]),
      includeThreadMetadata: false,
    });

    expect(projects[0]).toMatchObject({ threads: { total: 1, active: 0 } });
    expect(projects[0]).not.toHaveProperty("recentThreads");
  });

  it("mentions only tools granted to the integration", () => {
    expect(
      buildExternalMcpOverviewNextSteps(new Set<ExternalMcpCapability>(["projects:read"])),
    ).toEqual([
      "Call synara_capabilities with a projectId to list the exact provider/model targets available to this integration.",
    ]);
    expect(
      buildExternalMcpOverviewNextSteps(
        new Set<ExternalMcpCapability>([
          "projects:read",
          "tasks:create",
          "tasks:wait",
          "tasks:read",
        ]),
      ),
    ).toEqual([
      "Call synara_capabilities with a projectId to list the exact provider/model targets available to this integration.",
      "Create work with synara_create_task.",
      "Follow permitted work with synara_wait_for_task.",
      "Read permitted task results with synara_read_task.",
    ]);
  });
});
