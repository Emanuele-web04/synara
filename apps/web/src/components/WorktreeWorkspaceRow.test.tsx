import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorktreeWorkspaceRow } from "./WorktreeWorkspaceRow";
import { SidebarProvider } from "./ui/sidebar";

const workspace = {
  id: "workspace-empty",
  projectId: "project-1",
  kind: "managed",
  state: "ready",
  title: "Empty workspace",
  path: "/repo/empty",
  branch: "feature/empty",
  isPinned: false,
  archivedAt: null,
  deletedAt: null,
} as OrchestrationWorktreeWorkspace;

describe("WorktreeWorkspaceRow", () => {
  it("keeps a zero-conversation workspace operable with a fixed trailing slot", () => {
    const markup = renderToStaticMarkup(
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
          onOpenWorkspace={vi.fn()}
          onRenameWorkspace={vi.fn()}
          onContextMenuAction={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Open Empty workspace"');
    const rowButton = markup.match(/<button[^>]*aria-label="Open Empty workspace"[^>]*>/)?.[0];
    expect(rowButton).toBeDefined();
    expect(rowButton).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(markup).toContain('data-slot="worktree-row-trailing"');
    expect(markup).toContain("w-14");
    expect(markup).toContain('aria-label="Rename Empty workspace"');
  });

  it("forces the repository-root label and omits its rename affordance", () => {
    const root = {
      ...workspace,
      id: "workspace-root",
      kind: "repository-root",
      title: "synara",
    } as OrchestrationWorktreeWorkspace;
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <WorktreeWorkspaceRow
          workspace={root}
          isActive
          openConversationCount={1}
          contextMenuActions={{ "new-conversation": { label: "New conversation" } }}
          hoverCard={{
            branch: root.branch,
            branchUrl: null,
            path: root.path,
            source: "main",
            status: "ready",
            onOpenBranch: vi.fn(),
          }}
          onOpenWorkspace={vi.fn()}
          onRenameWorkspace={vi.fn()}
          onContextMenuAction={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain("Repository root");
    expect(markup).not.toContain("Rename Repository root");
  });
});
