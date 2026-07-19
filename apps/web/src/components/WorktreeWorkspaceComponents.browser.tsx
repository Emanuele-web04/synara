import "../index.css";

import {
  ProjectId,
  type OrchestrationWorktreeWorkspace,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { WorktreeWorkspaceContextMenu } from "./WorktreeWorkspaceContextMenu";
import { WorktreeWorkspaceHoverCardContent } from "./WorktreeWorkspaceHoverCardContent";
import { WorktreeWorkspaceRow } from "./WorktreeWorkspaceRow";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { SidebarProvider } from "./ui/sidebar";
import {
  type BranchRenameAvailability,
  WorktreeWorkspaceRenameDialog,
} from "./WorktreeWorkspaceRenameDialog";

const WORKSPACE_ID = WorktreeWorkspaceId.makeUnsafe("workspace-components-browser");
const PROJECT_ID = ProjectId.makeUnsafe("project-components-browser");

async function renderInBody(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(node, { container: host });
  return {
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function RenameDialogHarness({
  workspace,
  onRename,
}: {
  workspace: OrchestrationWorktreeWorkspace;
  onRename: (input: { title: string; renameBranch: boolean }) => Promise<void>;
}) {
  const [availability, setAvailability] = useState<BranchRenameAvailability>("checking");
  return (
    <>
      <button type="button" onClick={() => setAvailability("unverified")}>
        Fail publication check
      </button>
      <WorktreeWorkspaceRenameDialog
        open
        workspace={workspace}
        branchRenameAvailability={availability}
        onOpenChange={vi.fn()}
        onRename={onRename}
      />
    </>
  );
}

describe("WorktreeWorkspaceContextMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens at row geometry, focuses the first enabled action, and restores focus", async () => {
    const onAction = vi.fn();
    await using _ = await renderInBody(
      <WorktreeWorkspaceContextMenu
        trigger={<button type="button">Seller catalog workspace</button>}
        target={{ workspaceId: WORKSPACE_ID, workspacePath: "/repos/synara/seller-catalog" }}
        actions={{
          "new-conversation": { label: "New conversation", disabled: true },
          "show-in-folder": { label: "Show in Finder" },
          "rename-workspace": { label: "Rename workspace" },
          "publish-branch": { label: "Publish branch" },
        }}
        onAction={onAction}
      />,
    );

    const trigger = document.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    trigger.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 120, y: 48, width: 260, height: 32 });
    let contextMenuPoint: { x: number; y: number } | null = null;
    trigger.addEventListener("contextmenu", (event) => {
      contextMenuPoint = { x: event.clientX, y: event.clientY };
    });
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Show in Finder");
    expect(contextMenuPoint).toEqual({ x: 136, y: 80 });
    expect(document.body.textContent).toContain("New conversation");
    expect(document.body.textContent).toContain("Publish branch");

    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await expect.poll(() => document.activeElement).toBe(trigger);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("suppresses the native menu and passes the selected workspace target", async () => {
    const onAction = vi.fn();
    await using _ = await renderInBody(
      <WorktreeWorkspaceContextMenu
        trigger={<button type="button">Empty workspace</button>}
        target={{ workspaceId: WORKSPACE_ID, workspacePath: "/repos/synara/empty" }}
        actions={{ "new-conversation": { label: "New conversation" } }}
        onAction={onAction}
      />,
    );

    const trigger = document.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 36,
      button: 2,
    });
    trigger.dispatchEvent(contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    await page.getByRole("menuitem", { name: "New conversation" }).click();
    expect(onAction).toHaveBeenCalledWith("new-conversation", {
      workspaceId: WORKSPACE_ID,
      workspacePath: "/repos/synara/empty",
    });
  });
});

describe("WorktreeWorkspaceHoverCardContent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the absolute path for reveal and routes the PR primary action internally", async () => {
    const onRevealPath = vi.fn();
    const onOpenPullRequest = vi.fn();
    const onOpenBranch = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });
    const pullRequest = {
      number: 42,
      stateLabel: "Open",
      actionLabel: "Open pull request #42",
    };
    await using _ = await renderInBody(
      <WorktreeWorkspaceHoverCardContent
        title="Seller catalog"
        branch="synara/seller-catalog"
        branchUrl={null}
        branchPresentation={{
          name: "synara/seller-catalog",
          verifiedUrl: "https://github.com/example/repo/tree/synara/seller-catalog",
        }}
        path="~/.synara/worktrees/seller-catalog"
        pathPresentation={{
          displayPath: "~/.synara/worktrees/seller-catalog",
          absolutePath: "/Users/developer/.synara/worktrees/seller-catalog",
          revealLabel: "Show in Finder",
        }}
        publicationLabel="PR open"
        pullRequest={pullRequest}
        source="main"
        status="ready"
        openConversationCount={1}
        onOpenBranch={onOpenBranch}
        onRevealPath={onRevealPath}
        onOpenPullRequest={onOpenPullRequest}
      />,
    );

    await page
      .getByRole("button", { name: "Show in Finder: ~/.synara/worktrees/seller-catalog" })
      .click();
    expect(onRevealPath).toHaveBeenCalledWith("/Users/developer/.synara/worktrees/seller-catalog");

    await page.getByRole("button", { name: "Open pull request #42" }).click();
    expect(onOpenPullRequest).toHaveBeenCalledWith(pullRequest);

    await page.getByRole("link", { name: "Open synara/seller-catalog on GitHub" }).click();
    expect(onOpenBranch).toHaveBeenCalledWith(
      expect.anything(),
      "https://github.com/example/repo/tree/synara/seller-catalog",
    );
  });
});

describe("WorktreeWorkspaceRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps an empty workspace focusable and composes hover and keyboard context menus", async () => {
    const onOpenWorkspace = vi.fn();
    const onContextMenuAction = vi.fn();
    const workspace = {
      id: WORKSPACE_ID,
      kind: "managed",
      title: "Empty workspace",
      path: "/repos/synara/empty",
      branch: "feature/empty",
      state: "ready",
    } as OrchestrationWorktreeWorkspace;

    await using _ = await renderInBody(
      <SidebarProvider>
        <WorktreeWorkspaceRow
          workspace={workspace}
          isActive={false}
          openConversationCount={0}
          contextMenuActions={{ "new-conversation": { label: "New conversation" } }}
          hoverCard={{
            branch: workspace.branch,
            branchUrl: null,
            path: workspace.path,
            source: "main",
            status: "ready",
            onOpenBranch: vi.fn(),
          }}
          onOpenWorkspace={onOpenWorkspace}
          onRenameWorkspace={vi.fn()}
          onContextMenuAction={onContextMenuAction}
        />
      </SidebarProvider>,
    );

    const row = page.getByRole("button", { name: "Open Empty workspace" });
    await row.click();
    expect(onOpenWorkspace).toHaveBeenCalledWith(workspace);
    await row.hover();
    await expect.poll(() => document.body.textContent).toContain("No open conversations");

    const rowElement = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Empty workspace"]',
    );
    expect(rowElement).not.toBeNull();
    rowElement?.focus();
    rowElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ContextMenu",
        bubbles: true,
        cancelable: true,
      }),
    );
    await page.getByRole("menuitem", { name: "New conversation" }).click();
    expect(onContextMenuAction).toHaveBeenCalledWith("new-conversation", workspace);

    const trailing = document.querySelector<HTMLElement>('[data-slot="worktree-row-trailing"]');
    expect(trailing?.className).toContain("w-14");
  });
});

describe("ProjectContextMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens from Shift+F10 and dispatches only the selected project target", async () => {
    const onAction = vi.fn();
    await using _ = await renderInBody(
      <ProjectContextMenu
        trigger={<button type="button">Synara project</button>}
        target={{ projectId: PROJECT_ID, projectPath: "/repos/synara" }}
        actions={{
          "new-workspace": { label: "New workspace", disabled: true },
          "show-in-folder": { label: "Show repository in Finder" },
          "remove-project": { label: "Remove project", destructive: true },
        }}
        onAction={onAction}
      />,
    );

    const trigger = document.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    trigger?.focus();
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect
      .poll(() => document.activeElement?.textContent?.trim())
      .toBe("Show repository in Finder");
    await page.getByRole("menuitem", { name: "Show repository in Finder" }).click();
    expect(onAction).toHaveBeenCalledWith("show-in-folder", {
      projectId: PROJECT_ID,
      projectPath: "/repos/synara",
    });
  });
});

describe("WorktreeWorkspaceRenameDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("announces publication checking, preserves input after failure, and allows display-only retry", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("Workspace label update failed.");
    });
    const workspace = {
      id: WORKSPACE_ID,
      title: "Seller catalog",
      branch: "synara/seller-catalog",
      path: "/repos/synara/seller-catalog",
      state: "ready",
    } as OrchestrationWorktreeWorkspace;

    await using _ = await renderInBody(
      <RenameDialogHarness workspace={workspace} onRename={onRename} />,
    );

    await expect
      .poll(() => document.querySelector('[role="status"]')?.textContent)
      .toContain("Checking whether this branch is published");
    await page.getByRole("button", { name: "Fail publication check" }).click();
    await expect
      .poll(() => document.body.textContent)
      .toContain("You can still rename the workspace label.");

    const nameInput = page.getByRole("textbox", { name: "Workspace name" });
    await nameInput.fill("Catalog fixes");
    await page.getByRole("button", { name: "Rename workspace" }).click();
    await expect
      .poll(() => document.querySelector('[role="alert"]')?.textContent)
      .toBe("Workspace label update failed.");
    expect(document.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.value).toBe(
      "Catalog fixes",
    );
    expect(onRename).toHaveBeenCalledWith({ title: "Catalog fixes", renameBranch: false });
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  });
});
