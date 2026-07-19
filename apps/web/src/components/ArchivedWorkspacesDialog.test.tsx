import {
  type OrchestrationWorktreeWorkspace,
  type ProjectId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ArchivedWorkspacesList,
  createArchivedWorkspaceRestoreCallback,
} from "./ArchivedWorkspacesDialog";

const PROJECT_ID = "project-1" as ProjectId;
const archivedWorkspace = {
  id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
  projectId: PROJECT_ID,
  kind: "managed",
  state: "archived",
  title: "Seller catalog",
  path: null,
  branch: "feature/catalog",
  headRef: "feature/catalog",
  lastKnownPr: null,
  activeOperation: null,
  lastFailure: null,
  archivedAt: "2026-07-16T12:00:00.000Z",
  deletedAt: null,
} as OrchestrationWorktreeWorkspace;

describe("ArchivedWorkspacesDialog", () => {
  it("renders project-scoped workspace metadata and a restore action", () => {
    const markup = renderToStaticMarkup(
      <ArchivedWorkspacesList
        projectId={PROJECT_ID}
        projectName="Synara"
        workspaces={[
          archivedWorkspace,
          {
            ...archivedWorkspace,
            id: WorktreeWorkspaceId.makeUnsafe("workspace-root"),
            kind: "repository-root",
            title: "Repository root",
          },
        ]}
        onRestore={vi.fn()}
      />,
    );

    expect(markup).toContain("Archived workspaces for Synara");
    expect(markup).toContain("Seller catalog");
    expect(markup).toContain("feature/catalog");
    expect(markup).toContain("Managed workspace");
    expect(markup).toContain('aria-label="Restore Seller catalog"');
    expect(markup).not.toContain("Repository root");
  });

  it("renders loading, empty, and recoverable error states", () => {
    const renderState = (props: { isLoading?: boolean; loadError?: string | null }) =>
      renderToStaticMarkup(
        <ArchivedWorkspacesList
          projectId={PROJECT_ID}
          projectName="Synara"
          workspaces={[]}
          onRestore={vi.fn()}
          onRetry={vi.fn()}
          {...props}
        />,
      );

    expect(renderState({ isLoading: true })).toContain("Loading archived workspaces");
    expect(renderState({})).toContain("No archived workspaces");
    expect(renderState({ loadError: "Connection lost." })).toContain("Try again");
    expect(renderState({ loadError: "Connection lost." })).toContain("Connection lost.");
  });

  it("disables a pending restore and surfaces its recoverable error", () => {
    const pendingMarkup = renderToStaticMarkup(
      <ArchivedWorkspacesList
        projectId={PROJECT_ID}
        projectName="Synara"
        workspaces={[archivedWorkspace]}
        pendingWorkspaceIds={new Set(["workspace-1"])}
        restoreErrorsByWorkspaceId={new Map([["workspace-1", "The workspace path is occupied."]])}
        onRestore={vi.fn()}
      />,
    );

    expect(pendingMarkup).toContain("Restoring…");
    expect(pendingMarkup).toContain("disabled");
    expect(pendingMarkup).toContain("The workspace path is occupied.");
  });

  it("adapts a workspace callback to the lifecycle workspace id", async () => {
    const restore = vi.fn();
    await createArchivedWorkspaceRestoreCallback(restore)(archivedWorkspace);
    expect(restore).toHaveBeenCalledWith("workspace-1");
  });
});
