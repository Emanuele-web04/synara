import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";
import {
  contextualWorkspaceGitAction,
  type WorkspaceGitPresentationState,
} from "@synara/shared/pullRequest";

import type { WorktreeWorkspaceContextMenuActions } from "./WorktreeWorkspaceContextMenu";

export type WorktreeWorkspaceActionContext = {
  gitPresentationState: WorkspaceGitPresentationState;
  revealLabel: string;
  hasEditorIntegration?: boolean;
  devServerState?: "stopped" | "running" | null;
  devServerUrl?: string | null;
  verifiedBranchUrl?: string | null;
  hasReviewComments?: boolean;
  hasConflicts?: boolean;
  archiveEnabled?: boolean;
  removeExternalEnabled?: boolean;
};

export function isActiveWorktreeWorkspace(workspace: OrchestrationWorktreeWorkspace): boolean {
  return (
    workspace.deletedAt === null && workspace.archivedAt === null && workspace.state !== "archived"
  );
}

export function getWorktreeWorkspaceSidebarLabel(
  workspace: Pick<OrchestrationWorktreeWorkspace, "kind" | "title">,
): string {
  return workspace.kind === "repository-root" ? "Repository root" : workspace.title;
}

export function orderWorktreeWorkspacesForSidebar(
  workspaces: readonly OrchestrationWorktreeWorkspace[],
): OrchestrationWorktreeWorkspace[] {
  return workspaces
    .map((workspace, sourceIndex) => ({ workspace, sourceIndex }))
    .filter(({ workspace }) => isActiveWorktreeWorkspace(workspace))
    .toSorted((left, right) => {
      const rootOrder =
        Number(right.workspace.kind === "repository-root") -
        Number(left.workspace.kind === "repository-root");
      if (rootOrder !== 0) return rootOrder;

      const pinOrder = Number(right.workspace.isPinned) - Number(left.workspace.isPinned);
      return pinOrder !== 0 ? pinOrder : left.sourceIndex - right.sourceIndex;
    })
    .map(({ workspace }) => workspace);
}

function addGitAction(
  actions: WorktreeWorkspaceContextMenuActions,
  state: WorkspaceGitPresentationState,
): void {
  const action = contextualWorkspaceGitAction(state);
  if (!action.available || !action.label) return;
  if (state === "local-only") actions["publish-branch"] = { label: action.label };
  if (state === "published") actions["create-pull-request"] = { label: action.label };
  if (state.startsWith("pr-")) actions["view-pull-request"] = { label: action.label };
}

export function deriveWorktreeWorkspaceContextMenuActions(
  workspace: OrchestrationWorktreeWorkspace,
  context: WorktreeWorkspaceActionContext,
): WorktreeWorkspaceContextMenuActions {
  const actions: WorktreeWorkspaceContextMenuActions = {
    "new-conversation": { label: "New conversation" },
  };
  const hasPath = workspace.path !== null;
  const hasBranch = workspace.branch !== null;

  if (hasPath) {
    actions["show-in-folder"] = { label: context.revealLabel };
    actions["open-terminal"] = { label: "Open terminal at workspace" };
    actions["copy-path"] = { label: "Copy path" };
    if (context.hasEditorIntegration) {
      actions["open-in-editor"] = { label: "Open in editor" };
    }
  }

  if (context.devServerState === "running") {
    actions["stop-dev"] = { label: "Stop dev" };
    if (context.devServerUrl) {
      actions["open-dev-server"] = { label: "Open dev server" };
    }
  } else if (context.devServerState === "stopped" && hasPath) {
    actions["start-dev"] = { label: "Start dev" };
  }

  if (workspace.kind !== "repository-root") {
    actions["rename-workspace"] = { label: "Rename workspace" };
    actions["toggle-pin"] = { label: workspace.isPinned ? "Unpin workspace" : "Pin workspace" };
  }

  if (hasBranch) {
    addGitAction(actions, context.gitPresentationState);
    actions["copy-branch-name"] = { label: "Copy branch name" };
    if (
      context.verifiedBranchUrl &&
      context.gitPresentationState !== "local-only" &&
      context.gitPresentationState !== "unavailable" &&
      context.gitPresentationState !== "provisioning"
    ) {
      actions["open-branch-on-github"] = { label: "Open branch on GitHub" };
    }
    if (context.gitPresentationState === "pr-open" && context.hasReviewComments) {
      actions["fix-review-comments"] = { label: "Fix review comments" };
    }
    if (context.gitPresentationState === "pr-open" && context.hasConflicts) {
      actions["resolve-conflicts"] = { label: "Resolve conflicts" };
    }
  }

  if (workspace.kind === "managed" && context.archiveEnabled) {
    actions["archive-workspace"] = { label: "Archive workspace" };
  }
  if (workspace.kind === "external" && context.removeExternalEnabled) {
    actions["remove-from-synara"] = { label: "Remove from Synara", destructive: true };
  }

  return actions;
}
