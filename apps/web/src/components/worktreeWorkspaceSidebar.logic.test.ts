import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveWorktreeWorkspaceContextMenuActions,
  getWorktreeWorkspaceSidebarLabel,
  orderWorktreeWorkspacesForSidebar,
} from "./worktreeWorkspaceSidebar.logic";

function workspace(
  id: string,
  overrides: Partial<OrchestrationWorktreeWorkspace> = {},
): OrchestrationWorktreeWorkspace {
  return {
    id,
    projectId: "project-1",
    repositoryIdentity: "acme/synara",
    kind: "managed",
    state: "ready",
    title: id,
    path: `/repo/${id}`,
    branch: `feature/${id}`,
    headRef: null,
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
    lifecycleGeneration: 0,
    activeOperation: null,
    lastFailure: null,
    mutationRevision: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as OrchestrationWorktreeWorkspace;
}

describe("orderWorktreeWorkspacesForSidebar", () => {
  it("filters deleted and archived records, then orders root, pinned, and stable source order", () => {
    const ordinaryFirst = workspace("ordinary-first");
    const pinnedFirst = workspace("pinned-first", { isPinned: true });
    const ordinarySecond = workspace("ordinary-second");
    const root = workspace("root", { kind: "repository-root", title: "synara" });
    const pinnedSecond = workspace("pinned-second", { isPinned: true });
    const archivedByState = workspace("archived-by-state", {
      state: "archived",
    });
    const archivedByTimestamp = workspace("archived-by-timestamp", {
      archivedAt: "2026-07-15T01:00:00.000Z",
    });
    const deleted = workspace("deleted", { deletedAt: "2026-07-15T01:00:00.000Z" });

    expect(
      orderWorktreeWorkspacesForSidebar([
        ordinaryFirst,
        pinnedFirst,
        archivedByState,
        archivedByTimestamp,
        ordinarySecond,
        root,
        deleted,
        pinnedSecond,
      ]).map((item) => item.id),
    ).toEqual(["root", "pinned-first", "pinned-second", "ordinary-first", "ordinary-second"]);
  });

  it("uses the protected repository-root label", () => {
    expect(getWorktreeWorkspaceSidebarLabel(workspace("root", { kind: "repository-root" }))).toBe(
      "Repository root",
    );
    expect(
      getWorktreeWorkspaceSidebarLabel(workspace("feature", { title: "Seller catalog" })),
    ).toBe("Seller catalog");
  });
});

describe("deriveWorktreeWorkspaceContextMenuActions", () => {
  it("maps shared local and published presentation states to authoritative actions", () => {
    const item = workspace("seller-catalog");
    const local = deriveWorktreeWorkspaceContextMenuActions(item, {
      gitPresentationState: "local-only",
      revealLabel: "Show in Finder",
      verifiedBranchUrl: "https://github.com/acme/synara/tree/guessed",
    });
    expect(local["publish-branch"]?.label).toBe("Publish branch");
    expect(local["create-pull-request"]).toBeUndefined();
    expect(local["open-branch-on-github"]).toBeUndefined();

    const published = deriveWorktreeWorkspaceContextMenuActions(item, {
      gitPresentationState: "published",
      revealLabel: "Show in Finder",
      verifiedBranchUrl: "https://github.com/acme/synara/tree/feature/seller-catalog",
    });
    expect(published["create-pull-request"]?.label).toBe("Create pull request");
    expect(published["open-branch-on-github"]?.label).toBe("Open branch on GitHub");
  });

  it("adds PR remedies and keeps lifecycle actions capability-gated", () => {
    const item = workspace("review");
    const actions = deriveWorktreeWorkspaceContextMenuActions(item, {
      gitPresentationState: "pr-open",
      revealLabel: "Show in File Explorer",
      hasReviewComments: true,
      hasConflicts: true,
    });
    expect(actions["view-pull-request"]?.label).toBe("View pull request");
    expect(actions["fix-review-comments"]?.label).toBe("Fix review comments");
    expect(actions["resolve-conflicts"]?.label).toBe("Resolve conflicts");
    expect(actions["archive-workspace"]).toBeUndefined();

    expect(
      deriveWorktreeWorkspaceContextMenuActions(item, {
        gitPresentationState: "pr-merged",
        revealLabel: "Show in Finder",
        archiveEnabled: true,
      })["archive-workspace"]?.label,
    ).toBe("Archive workspace");
  });

  it("protects repository root and detaches external workspaces only when supported", () => {
    const rootActions = deriveWorktreeWorkspaceContextMenuActions(
      workspace("root", { kind: "repository-root" }),
      {
        gitPresentationState: "published",
        revealLabel: "Show in Finder",
        archiveEnabled: true,
      },
    );
    expect(rootActions["archive-workspace"]).toBeUndefined();
    expect(rootActions["remove-from-synara"]).toBeUndefined();
    expect(rootActions["rename-workspace"]).toBeUndefined();

    const externalActions = deriveWorktreeWorkspaceContextMenuActions(
      workspace("external", { kind: "external" }),
      {
        gitPresentationState: "published",
        revealLabel: "Show in Finder",
        removeExternalEnabled: true,
      },
    );
    expect(externalActions["remove-from-synara"]).toMatchObject({
      label: "Remove from Synara",
      destructive: true,
    });
  });
});
