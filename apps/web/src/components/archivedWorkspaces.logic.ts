import type { OrchestrationWorktreeWorkspace, ProjectId } from "@synara/contracts";
import { presentPullRequestState } from "@synara/shared/pullRequest";

export interface ArchivedWorkspacePresentation {
  readonly title: string;
  readonly branchLabel: string;
  readonly pullRequestLabel: string | null;
  readonly archivedAtLabel: string;
  readonly kindLabel: string;
}

export interface ArchiveTimeFormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

export function isArchivedWorkspaceForProject(
  workspace: OrchestrationWorktreeWorkspace,
  projectId: ProjectId,
): boolean {
  return (
    workspace.projectId === projectId &&
    workspace.kind !== "repository-root" &&
    workspace.deletedAt === null &&
    (workspace.archivedAt !== null || workspace.state === "archived")
  );
}

export function listArchivedWorkspaces(
  workspaces: readonly OrchestrationWorktreeWorkspace[],
  projectId: ProjectId,
): OrchestrationWorktreeWorkspace[] {
  return workspaces
    .filter((workspace) => isArchivedWorkspaceForProject(workspace, projectId))
    .sort((left, right) => {
      const timeOrder = (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "");
      if (timeOrder !== 0) return timeOrder;
      return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    });
}

export function formatWorkspaceArchiveTime(
  archivedAt: string | null,
  options: ArchiveTimeFormatOptions = {},
): string {
  if (archivedAt === null) return "Archive time unavailable";
  const date = new Date(archivedAt);
  if (Number.isNaN(date.getTime())) return "Archive time unavailable";

  const formattedDate = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);
  return `Archived ${formattedDate}`;
}

export function presentArchivedWorkspace(
  workspace: OrchestrationWorktreeWorkspace,
  options?: ArchiveTimeFormatOptions,
): ArchivedWorkspacePresentation {
  return {
    title: workspace.title,
    branchLabel: workspace.branch ?? workspace.headRef ?? "Branch unavailable",
    pullRequestLabel:
      workspace.lastKnownPr === null
        ? null
        : `#${workspace.lastKnownPr.number} · ${presentPullRequestState(workspace.lastKnownPr)}`,
    archivedAtLabel: formatWorkspaceArchiveTime(workspace.archivedAt, options),
    kindLabel: workspace.kind === "managed" ? "Managed workspace" : "External workspace",
  };
}

export function isWorkspaceRestorePending(
  workspace: OrchestrationWorktreeWorkspace,
  pendingWorkspaceIds: ReadonlySet<string>,
): boolean {
  return (
    pendingWorkspaceIds.has(workspace.id) ||
    workspace.activeOperation?.kind === "restore" ||
    (workspace.state === "provisioning" && workspace.archivedAt !== null)
  );
}

export function workspaceRestoreError(
  workspace: OrchestrationWorktreeWorkspace,
  errorsByWorkspaceId: ReadonlyMap<string, string>,
): string | null {
  const transientError = errorsByWorkspaceId.get(workspace.id)?.trim();
  if (transientError) return transientError;
  if (workspace.lastFailure?.kind === "restore") return workspace.lastFailure.summary;
  return null;
}
