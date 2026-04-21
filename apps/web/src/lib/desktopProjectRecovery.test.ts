// FILE: desktopProjectRecovery.test.ts
// Purpose: Verifies desktop startup detects snapshots where threads outlive visible project rows.

import { ProjectId, ThreadId, type OrchestrationReadModel } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { hasLiveThreadsWithMissingProjects } from "./desktopProjectRecovery";

function makeProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]> = {},
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    scripts: [],
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: "chat",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    handoff: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<OrchestrationReadModel> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-04-20T08:00:00.000Z",
    projects: [makeProject()],
    threads: [makeThread()],
    ...overrides,
  };
}

describe("desktopProjectRecovery", () => {
  it("returns false when live threads still have live project rows", () => {
    const snapshot = makeSnapshot();

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(false);
  });

  it("returns true when a live thread references a missing project row", () => {
    const snapshot = makeSnapshot({
      projects: [],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(true);
  });

  it("returns true when a live thread references a deleted project row", () => {
    const snapshot = makeSnapshot({
      projects: [makeProject({ deletedAt: "2026-04-20T09:00:00.000Z" })],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(true);
  });

  it("ignores deleted threads when deciding whether repair is needed", () => {
    const snapshot = makeSnapshot({
      projects: [],
      threads: [makeThread({ deletedAt: "2026-04-20T09:00:00.000Z" })],
    });

    expect(hasLiveThreadsWithMissingProjects(snapshot)).toBe(false);
  });
});
