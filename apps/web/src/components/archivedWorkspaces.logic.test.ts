import {
  type OrchestrationWorktreeWorkspace,
  type ProjectId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  formatWorkspaceArchiveTime,
  isWorkspaceRestorePending,
  listArchivedWorkspaces,
  presentArchivedWorkspace,
  workspaceRestoreError,
} from "./archivedWorkspaces.logic";

const PROJECT_ID = "project-1" as ProjectId;

function workspace(
  overrides: Partial<OrchestrationWorktreeWorkspace> = {},
): OrchestrationWorktreeWorkspace {
  return {
    id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
    projectId: PROJECT_ID,
    repositoryIdentity: "github.com/example/repo",
    kind: "managed",
    state: "archived",
    title: "Seller catalog",
    path: null,
    branch: "feature/catalog",
    headRef: "feature/catalog",
    targetRef: "main",
    targetResolvedCommit: null,
    createdFromCommit: null,
    sourceKind: "branch",
    sourceRef: null,
    setupStatus: "succeeded",
    setupError: null,
    setupLogId: null,
    lastKnownPr: null,
    isPinned: false,
    lifecycleGeneration: 1,
    activeOperation: null,
    lastFailure: null,
    mutationRevision: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    archivedAt: "2026-07-16T12:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as OrchestrationWorktreeWorkspace;
}

describe("archived workspace presentation", () => {
  it("filters to the selected project, excludes repository roots, and sorts newest first", () => {
    const result = listArchivedWorkspaces(
      [
        workspace({
          id: WorktreeWorkspaceId.makeUnsafe("older"),
          title: "Older",
          archivedAt: "2026-07-15T12:00:00.000Z",
        }),
        workspace({ id: WorktreeWorkspaceId.makeUnsafe("root"), kind: "repository-root" }),
        workspace({
          id: WorktreeWorkspaceId.makeUnsafe("active"),
          state: "ready",
          archivedAt: null,
        }),
        workspace({
          id: WorktreeWorkspaceId.makeUnsafe("deleted"),
          deletedAt: "2026-07-16T13:00:00.000Z",
        }),
        workspace({
          id: WorktreeWorkspaceId.makeUnsafe("other-project"),
          projectId: "project-2" as ProjectId,
          archivedAt: "2026-07-17T12:00:00.000Z",
        }),
        workspace({
          id: WorktreeWorkspaceId.makeUnsafe("newer"),
          title: "Newer",
          archivedAt: "2026-07-16T12:00:00.000Z",
        }),
      ],
      PROJECT_ID,
    );

    expect(result.map(({ id }) => id)).toEqual(["newer", "older"]);
  });

  it("presents branch, kind, PR state, and a deterministic archive time", () => {
    const archived = workspace({
      kind: "external",
      lastKnownPr: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
        state: "open",
        isDraft: true,
        mergeability: "mergeable",
      } as NonNullable<OrchestrationWorktreeWorkspace["lastKnownPr"]>,
    });

    expect(presentArchivedWorkspace(archived, { locale: "en-US", timeZone: "UTC" })).toEqual({
      title: "Seller catalog",
      branchLabel: "feature/catalog",
      pullRequestLabel: "#42 · Draft PR",
      archivedAtLabel: "Archived Jul 16, 2026, 12:00 PM",
      kindLabel: "External workspace",
    });
    expect(formatWorkspaceArchiveTime(null)).toBe("Archive time unavailable");
    expect(formatWorkspaceArchiveTime("not-a-date")).toBe("Archive time unavailable");
  });

  it("combines projected and local pending/error state", () => {
    const restoring = workspace({
      activeOperation: {
        id: "operation-1",
        generation: 2,
        kind: "restore",
        stage: "materializing",
        startedAt: "2026-07-16T13:00:00.000Z",
      },
      lastFailure: {
        generation: 1,
        kind: "restore",
        stage: "materializing",
        summary: "The workspace path is occupied.",
        logId: null,
      },
    } as Partial<OrchestrationWorktreeWorkspace>);

    expect(isWorkspaceRestorePending(restoring, new Set())).toBe(true);
    expect(isWorkspaceRestorePending(workspace(), new Set(["workspace-1"]))).toBe(true);
    expect(workspaceRestoreError(restoring, new Map())).toBe("The workspace path is occupied.");
    expect(workspaceRestoreError(restoring, new Map([["workspace-1", "Please retry."]]))).toBe(
      "Please retry.",
    );
  });
});
