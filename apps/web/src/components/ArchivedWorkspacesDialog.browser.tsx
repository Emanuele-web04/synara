import "../index.css";

import type { OrchestrationWorktreeWorkspace, ProjectId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ArchivedWorkspacesDialog } from "./ArchivedWorkspacesDialog";

const PROJECT_ID = "project-1" as ProjectId;
const workspace = {
  id: "workspace-1",
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
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("restores the selected archived workspace and disables pending work", async () => {
    const onRestore = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ArchivedWorkspacesDialog
        open
        projectId={PROJECT_ID}
        projectName="Synara"
        workspaces={[workspace]}
        onOpenChange={vi.fn()}
        onRestore={onRestore}
      />,
      { container: host },
    );

    await page.getByRole("button", { name: "Restore Seller catalog" }).click();
    expect(onRestore).toHaveBeenCalledWith(workspace);
    await screen.rerender(
      <ArchivedWorkspacesDialog
        open
        projectId={PROJECT_ID}
        projectName="Synara"
        workspaces={[workspace]}
        pendingWorkspaceIds={new Set(["workspace-1"])}
        onOpenChange={vi.fn()}
        onRestore={onRestore}
      />,
    );

    const button = page.getByRole("button", { name: "Restore Seller catalog" });
    await expect.element(button).toBeDisabled();
    expect(document.body.textContent).toContain("Restoring…");
    await screen.unmount();
  });
});
