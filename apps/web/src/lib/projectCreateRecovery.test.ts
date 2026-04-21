// FILE: projectCreateRecovery.test.ts
// Purpose: Verifies duplicate `project.create` recovery helpers used by import flows.

import { describe, expect, it } from "vitest";

import {
  extractDuplicateProjectCreateProjectId,
  findRecoverableProject,
  findRecoverableProjectForDuplicateCreate,
  isDuplicateProjectCreateError,
  waitForRecoverableProjectInReadModel,
  waitForRecoverableProjectForDuplicateCreate,
} from "./projectCreateRecovery";

describe("projectCreateRecovery", () => {
  it("detects duplicate project.create invariant failures", () => {
    expect(
      isDuplicateProjectCreateError(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      ),
    ).toBe(true);
  });

  it("extracts the existing project id from duplicate invariant failures", () => {
    expect(
      extractDuplicateProjectCreateProjectId(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      ),
    ).toBe("project-123");
  });

  it("prefers the explicit duplicate project id when recovering from a server snapshot", () => {
    const recovered = findRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      projects: [
        {
          id: "project-123",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/one",
          deletedAt: null,
        },
        {
          id: "project-456",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/two",
          deletedAt: null,
        },
      ],
      workspaceRoot: "/Users/tester/Code/one",
    });

    expect(recovered?.id).toBe("project-123");
  });

  it("finds a recoverable project by exact id before falling back to workspace root", () => {
    const recovered = findRecoverableProject({
      projectId: "project-123",
      workspaceRoot: "/Users/tester/Code/one",
      projects: [
        {
          id: "project-123",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/two",
          deletedAt: null,
        },
        {
          id: "project-456",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/one",
          deletedAt: null,
        },
      ],
    });

    expect(recovered?.id).toBe("project-123");
  });

  it("falls back to workspace-root matching when the duplicate id is not available locally", () => {
    const recovered = findRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      projects: [
        {
          id: "project-456",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/one/",
          deletedAt: null,
        },
      ],
      workspaceRoot: "/Users/tester/Code/one",
    });

    expect(recovered?.id).toBe("project-456");
  });

  it("treats a missing kind like a normal project during recovery", () => {
    const recovered = findRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      projects: [
        {
          id: "project-123",
          workspaceRoot: "/Users/tester/Code/one",
          deletedAt: null,
        },
      ],
      workspaceRoot: "/Users/tester/Code/one",
    });

    expect(recovered?.id).toBe("project-123");
  });

  it("ignores deleted and non-project rows during recovery", () => {
    const recovered = findRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      projects: [
        {
          id: "project-123",
          kind: "chat",
          workspaceRoot: "/Users/tester/Code/one",
          deletedAt: null,
        },
        {
          id: "project-789",
          kind: "project",
          workspaceRoot: "/Users/tester/Code/one",
          deletedAt: "2026-04-18T10:00:00.000Z",
        },
      ],
      workspaceRoot: "/Users/tester/Code/one",
    });

    expect(recovered).toBeNull();
  });

  it("retries snapshot reads before giving up on duplicate recovery", async () => {
    let attempts = 0;

    const result = await waitForRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      workspaceRoot: "/Users/tester/Code/one",
      loadSnapshot: async () => {
        attempts += 1;
        if (attempts < 3) {
          return {
            projects: [],
          };
        }

        return {
          projects: [
            {
              id: "project-123",
              workspaceRoot: "/Users/tester/Code/one",
              deletedAt: null,
            },
          ],
        };
      },
      maxAttempts: 3,
      delayMs: 0,
    });

    expect(attempts).toBe(3);
    expect(result.project?.id).toBe("project-123");
    expect(result.snapshot?.projects).toHaveLength(1);
  });

  it("repairs the snapshot after polling when a directly created project is still missing", async () => {
    let repairCalls = 0;

    const result = await waitForRecoverableProjectInReadModel({
      projectId: "project-123",
      workspaceRoot: "/Users/tester/Code/one",
      loadSnapshot: async () => ({
        snapshotSequence: 1,
        updatedAt: "2026-04-21T00:00:00.000Z",
        projects: [],
        threads: [],
      }),
      repairSnapshot: async () => {
        repairCalls += 1;
        return {
          snapshotSequence: 2,
          updatedAt: "2026-04-21T00:00:01.000Z",
          projects: [
            {
              id: "project-123",
              kind: "project",
              title: "One",
              workspaceRoot: "/Users/tester/Code/one",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-04-21T00:00:00.000Z",
              updatedAt: "2026-04-21T00:00:01.000Z",
              deletedAt: null,
            },
          ],
          threads: [],
        };
      },
      maxAttempts: 2,
      delayMs: 0,
    });

    expect(repairCalls).toBe(1);
    expect(result.project?.id).toBe("project-123");
    expect(result.snapshot?.projects).toHaveLength(1);
  });

  it("repairs duplicate-create recovery when the fresh snapshot still has no project rows", async () => {
    let repairCalls = 0;

    const result = await waitForRecoverableProjectForDuplicateCreate({
      message:
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      workspaceRoot: "/Users/tester/Code/one",
      loadSnapshot: async () => ({
        projects: [],
      }),
      repairSnapshot: async () => {
        repairCalls += 1;
        return {
          projects: [
            {
              id: "project-123",
              workspaceRoot: "/Users/tester/Code/one",
              deletedAt: null,
            },
          ],
        };
      },
      maxAttempts: 2,
      delayMs: 0,
    });

    expect(repairCalls).toBe(1);
    expect(result.project?.id).toBe("project-123");
    expect(result.snapshot?.projects).toHaveLength(1);
  });
});
