import type {
  OrchestrationWorktreeWorkspace,
  ProjectId,
  WorktreeWorkspaceId,
} from "@synara/contracts";

import {
  isWorkspaceRestorePending,
  listArchivedWorkspaces,
  presentArchivedWorkspace,
  workspaceRestoreError,
} from "./archivedWorkspaces.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Spinner } from "./ui/spinner";
import {
  ArchiveIcon,
  ClockIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RotateCcwIcon,
} from "~/lib/icons";

const EMPTY_WORKSPACE_IDS: ReadonlySet<string> = new Set();
const EMPTY_ERRORS: ReadonlyMap<string, string> = new Map();

export interface ArchivedWorkspacesDialogProps {
  readonly open: boolean;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly workspaces: readonly OrchestrationWorktreeWorkspace[];
  readonly isLoading?: boolean;
  readonly loadError?: string | null;
  readonly pendingWorkspaceIds?: ReadonlySet<string>;
  readonly restoreErrorsByWorkspaceId?: ReadonlyMap<string, string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestore: (workspace: OrchestrationWorktreeWorkspace) => void | Promise<void>;
  readonly onRetry?: () => void;
}

export type ArchivedWorkspacesListProps = Pick<
  ArchivedWorkspacesDialogProps,
  | "projectId"
  | "projectName"
  | "workspaces"
  | "isLoading"
  | "loadError"
  | "pendingWorkspaceIds"
  | "restoreErrorsByWorkspaceId"
  | "onRestore"
  | "onRetry"
>;

function ArchivedWorkspaceRow({
  workspace,
  isPending,
  error,
  onRestore,
}: {
  readonly workspace: OrchestrationWorktreeWorkspace;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly onRestore: (workspace: OrchestrationWorktreeWorkspace) => void | Promise<void>;
}) {
  const presentation = presentArchivedWorkspace(workspace);
  const descriptionId = `archived-workspace-${workspace.id}-details`;

  return (
    <li className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{presentation.title}</span>
          <Badge className="shrink-0" variant="secondary">
            {presentation.kindLabel}
          </Badge>
        </div>
        <div
          id={descriptionId}
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
        >
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{presentation.branchLabel}</span>
          </span>
          {presentation.pullRequestLabel !== null ? (
            <span className="inline-flex items-center gap-1">
              <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
              {presentation.pullRequestLabel}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <ClockIcon aria-hidden="true" className="size-3.5" />
            {presentation.archivedAtLabel}
          </span>
        </div>
        {error !== null ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        aria-describedby={descriptionId}
        aria-label={`Restore ${presentation.title}`}
        className="self-start sm:self-center"
        disabled={isPending}
        size="sm"
        variant="outline"
        onClick={() => void onRestore(workspace)}
      >
        {isPending ? (
          <Spinner aria-hidden="true" className="size-3.5" role="presentation" />
        ) : (
          <RotateCcwIcon />
        )}
        {isPending ? "Restoring…" : "Restore"}
      </Button>
    </li>
  );
}

export function ArchivedWorkspacesList({
  projectId,
  projectName,
  workspaces,
  isLoading = false,
  loadError = null,
  pendingWorkspaceIds = EMPTY_WORKSPACE_IDS,
  restoreErrorsByWorkspaceId = EMPTY_ERRORS,
  onRestore,
  onRetry,
}: ArchivedWorkspacesListProps) {
  const archivedWorkspaces = listArchivedWorkspaces(workspaces, projectId);

  if (isLoading) {
    return (
      <div
        className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" className="size-4" role="presentation" />
        Loading archived workspaces…
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center gap-3 text-center"
        role="alert"
      >
        <div>
          <p className="text-sm font-medium">Archived workspaces couldn’t be loaded</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{loadError}</p>
        </div>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  if (archivedWorkspaces.length === 0) {
    return (
      <Empty className="min-h-40 gap-3 p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArchiveIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">No archived workspaces</EmptyTitle>
          <EmptyDescription>
            Workspaces archived from this project will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul
      aria-label={`Archived workspaces for ${projectName}`}
      className="divide-y divide-[color:var(--color-border)] overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]"
    >
      {archivedWorkspaces.map((workspace) => (
        <ArchivedWorkspaceRow
          key={workspace.id}
          workspace={workspace}
          isPending={isWorkspaceRestorePending(workspace, pendingWorkspaceIds)}
          error={workspaceRestoreError(workspace, restoreErrorsByWorkspaceId)}
          onRestore={onRestore}
        />
      ))}
    </ul>
  );
}

export function ArchivedWorkspacesDialog({
  open,
  projectId,
  projectName,
  workspaces,
  isLoading = false,
  loadError = null,
  pendingWorkspaceIds = EMPTY_WORKSPACE_IDS,
  restoreErrorsByWorkspaceId = EMPTY_ERRORS,
  onOpenChange,
  onRestore,
  onRetry,
}: ArchivedWorkspacesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl gap-0 p-0" surface="solid">
        <DialogHeader className="gap-1 p-4 pr-12">
          <DialogTitle className="text-base">Archived workspaces</DialogTitle>
          <DialogDescription className="text-xs">
            Restore workspaces for {projectName}. Conversations and local branches stay attached.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[min(62vh,540px)] px-4 py-3">
          <ArchivedWorkspacesList
            projectId={projectId}
            projectName={projectName}
            workspaces={workspaces}
            isLoading={isLoading}
            loadError={loadError}
            pendingWorkspaceIds={pendingWorkspaceIds}
            restoreErrorsByWorkspaceId={restoreErrorsByWorkspaceId}
            onRestore={onRestore}
            {...(onRetry ? { onRetry } : {})}
          />
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export type ArchivedWorkspaceRestoreHandler = (
  workspaceId: WorktreeWorkspaceId,
) => void | Promise<void>;

export function createArchivedWorkspaceRestoreCallback(
  restoreWorkspace: ArchivedWorkspaceRestoreHandler,
): (workspace: OrchestrationWorktreeWorkspace) => Promise<void> {
  return async (workspace) => restoreWorkspace(workspace.id);
}
