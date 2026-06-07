import type { ProjectId, ThreadWorkspaceContext } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  isPendingThreadWorktree,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceState,
} from "@t3tools/shared/threadEnvironment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LuSplit } from "react-icons/lu";
import { useCallback, useMemo, useState } from "react";
import { CentralIcon } from "~/lib/central-icons";
import { PlusIcon, XIcon } from "~/lib/icons";

import { gitBranchesQueryOptions, gitCreateWorktreeMutationOptions } from "../../lib/gitReactQuery";
import { hasWorkspaceContextSignature } from "../../lib/workspaceContextLogic";
import { cn } from "../../lib/utils";
import type { Project, ThreadWorkspacePatch } from "../../types";
import {
  dedupeRemoteBranchesWithLocalMatches,
  resolveEffectiveEnvMode,
  type EnvMode,
} from "../BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { FolderClosed } from "../FolderClosed";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

function WorktreeGlyph({ className }: { className?: string }) {
  return <LuSplit className={cn("rotate-90", className)} />;
}

function WorkspaceContextChip(props: {
  context: ThreadWorkspaceContext;
  project: Project | undefined;
  isPrimary: boolean;
  onUpdateContext: (patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">) => void;
  onMakePrimary: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const projectCwd = props.project?.cwd ?? null;
  const branchesQuery = useQuery({
    ...gitBranchesQueryOptions(projectCwd),
    enabled: Boolean(projectCwd),
  });
  const isGitRepo = branchesQuery.data?.isRepo ?? false;
  const label =
    props.context.label ?? props.project?.name ?? props.project?.folderName ?? "Workspace";
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath: props.context.worktreePath,
    hasServerThread: true,
    draftThreadEnvMode: props.context.envMode,
    serverThreadEnvMode: props.context.envMode,
  });
  const branchCwd =
    resolveThreadBranchSourceCwd({
      projectCwd,
      worktreePath: props.context.worktreePath,
    }) ?? projectCwd;
  const workspaceState = resolveThreadWorkspaceState({
    envMode: props.context.envMode,
    worktreePath: props.context.worktreePath,
  });
  const isPendingWorktree = isPendingThreadWorktree({
    envMode: props.context.envMode,
    worktreePath: props.context.worktreePath,
  });

  const setContextWorkspace = useCallback(
    (patch: ThreadWorkspacePatch) => {
      if (!projectCwd) return;
      props.onUpdateContext({
        ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
        ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
        ...(patch.envMode !== undefined ? { envMode: patch.envMode } : {}),
      });
    },
    [projectCwd, props],
  );

  const onEnvModeChange = useCallback(
    (mode: EnvMode) => {
      setContextWorkspace({
        envMode: mode,
        ...(mode === "local" ? { worktreePath: null } : {}),
      });
    },
    [setContextWorkspace],
  );

  const handleCreateWorktree = useCallback(async () => {
    if (!projectCwd || !props.context.branch || createWorktreeMutation.isPending) return;
    const result = await createWorktreeMutation.mutateAsync({
      cwd: projectCwd,
      branch: props.context.branch,
      newBranch: buildTemporaryWorktreeBranchName(),
    });
    setContextWorkspace({
      envMode: "worktree",
      branch: result.worktree.branch,
      worktreePath: result.worktree.path,
    });
  }, [
    createWorktreeMutation,
    projectCwd,
    props.context.branch,
    setContextWorkspace,
  ]);

  const showBranchControls = isGitRepo && projectCwd;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1",
        props.isPrimary
          ? "border-border/80 bg-muted/30 text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground",
        isPendingWorktree && "border-amber-500/40 bg-amber-500/10",
      )}
      title={projectCwd ?? label}
    >
      <FolderClosed className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="max-w-36 truncate font-medium">{label}</span>
      {props.context.branch ? (
        <span className="max-w-24 truncate text-muted-foreground/80">{props.context.branch}</span>
      ) : null}
      {showBranchControls ? (
        <>
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="inline-flex items-center rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                  title={
                    effectiveEnvMode === "worktree"
                      ? "Worktree context — click to change"
                      : "Local context — click to change"
                  }
                />
              }
            >
              {effectiveEnvMode === "worktree" ? (
                <WorktreeGlyph className="size-3" />
              ) : (
                <CentralIcon name="macbook" className="size-3" />
              )}
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-40">
              <MenuRadioGroup
                value={effectiveEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") {
                    onEnvModeChange(value);
                  }
                }}
              >
                <MenuRadioItem value="local">
                  <span className="inline-flex items-center gap-2">
                    <CentralIcon name="macbook" className="size-3.5 shrink-0" />
                    Local checkout
                  </span>
                </MenuRadioItem>
                <MenuRadioItem value="worktree">
                  <span className="inline-flex items-center gap-2">
                    <WorktreeGlyph className="size-3.5 shrink-0" />
                    New worktree
                  </span>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <BranchToolbarBranchSelector
            activeProjectCwd={projectCwd}
            activeThreadBranch={props.context.branch}
            activeWorktreePath={props.context.worktreePath}
            branchCwd={branchCwd}
            effectiveEnvMode={effectiveEnvMode}
            envLocked={false}
            onSetThreadWorkspace={setContextWorkspace}
            menuSide="bottom"
            variant="toolbar"
          />
        </>
      ) : null}
      {isPendingWorktree ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-5 px-1.5 text-[10px]"
          disabled={!props.context.branch || createWorktreeMutation.isPending}
          onClick={() => {
            void handleCreateWorktree();
          }}
        >
          {createWorktreeMutation.isPending ? "Creating…" : "Create worktree"}
        </Button>
      ) : workspaceState === "worktree-ready" && !props.isPrimary ? (
        <span className="rounded-full bg-background/70 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          worktree
        </span>
      ) : null}
      {props.isPrimary ? (
        <span className="rounded px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          primary
        </span>
      ) : (
        <button
          type="button"
          className="rounded px-1 text-[10px] text-muted-foreground/80 hover:text-foreground"
          onClick={props.onMakePrimary}
        >
          Set primary
        </button>
      )}
      {props.context.id !== "primary" ? (
        <button
          type="button"
          className="ml-0.5 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${label} context`}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function AddBranchContextSubmenu(props: {
  project: Project;
  contexts: readonly ThreadWorkspaceContext[];
  onAddBranchContext: (
    projectId: ProjectId,
    patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const branchesQuery = useQuery({
    ...gitBranchesQueryOptions(props.project.cwd),
    enabled: open && Boolean(props.project.cwd),
  });
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const isRepo = branchesQuery.data?.isRepo ?? false;
  const projectLabel = props.project.name || props.project.folderName || "project";
  const availableBranches = useMemo(
    () =>
      branches.filter(
        (branch) =>
          !hasWorkspaceContextSignature(props.contexts, {
            projectId: props.project.id,
            envMode: "local",
            branch: branch.name,
            worktreePath: null,
          }),
      ),
    [branches, props.contexts, props.project.id],
  );

  if (!isRepo) {
    return null;
  }

  return (
    <MenuSub open={open} onOpenChange={setOpen}>
      <MenuSubTrigger className="min-w-0">
        <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">Add branch for {projectLabel}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-48">
        {branchesQuery.isLoading ? (
          <MenuItem disabled>Loading branches…</MenuItem>
        ) : availableBranches.length > 0 ? (
          availableBranches.map((branch) => (
            <MenuItem
              key={branch.name}
              onClick={() => {
                props.onAddBranchContext(props.project.id, {
                  branch: branch.name,
                  envMode: "local",
                  worktreePath: null,
                });
              }}
            >
              <span className="min-w-0 truncate">{branch.name}</span>
            </MenuItem>
          ))
        ) : (
          <MenuItem disabled>All branches attached</MenuItem>
        )}
      </MenuSubPopup>
    </MenuSub>
  );
}

export function WorkspaceContextsBar(props: {
  projects: readonly Project[];
  contexts: readonly ThreadWorkspaceContext[];
  activeContextId: string | null;
  className?: string;
  /** Hide the primary chip when another control (e.g. ProjectPicker) already shows it. */
  hidePrimaryChip?: boolean;
  onBrowseFolder?: () => void;
  onAddProjectContext: (projectId: ProjectId) => void;
  onAddBranchContext: (
    projectId: ProjectId,
    patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
  ) => void;
  onRemoveContext: (contextId: string) => void;
  onMakePrimary: (contextId: string) => void;
  onUpdateContext: (
    contextId: string,
    patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
  ) => void;
}) {
  const representedProjectIds = useMemo(
    () => new Set(props.contexts.map((context) => context.projectId)),
    [props.contexts],
  );
  const availableFolderProjects = useMemo(
    () =>
      props.projects.filter(
        (project) => project.kind === "project" && !representedProjectIds.has(project.id),
      ),
    [props.projects, representedProjectIds],
  );
  const branchContextProjects = useMemo(
    () => props.projects.filter((project) => project.kind === "project"),
    [props.projects],
  );
  const activeContextId = props.activeContextId ?? props.contexts[0]?.id ?? null;
  const visibleContexts = props.hidePrimaryChip
    ? props.contexts.filter((context) => context.role !== "primary" && context.id !== "primary")
    : props.contexts;

  return (
    <div className={cn("flex min-h-8 items-center text-xs", props.className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {visibleContexts.map((context) => {
          const project = props.projects.find((entry) => entry.id === context.projectId);
          const isPrimary = context.id === activeContextId || context.role === "primary";
          return (
            <WorkspaceContextChip
              key={context.id}
              context={context}
              project={project}
              isPrimary={isPrimary}
              onUpdateContext={(patch) => props.onUpdateContext(context.id, patch)}
              onMakePrimary={() => props.onMakePrimary(context.id)}
              onRemove={() => props.onRemoveContext(context.id)}
            />
          );
        })}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Add workspace context"
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/70 px-2 py-1 text-muted-foreground transition-colors hover:border-border hover:bg-muted/20 hover:text-foreground"
              />
            }
          >
            <PlusIcon className="size-3" aria-hidden="true" />
            <span>Add context</span>
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="bottom" className="min-w-52">
            {availableFolderProjects.length > 0 ? (
              availableFolderProjects.map((project) => (
                <MenuItem
                  key={project.id}
                  onClick={() => {
                    props.onAddProjectContext(project.id);
                  }}
                >
                  <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 truncate">{project.name || project.folderName}</span>
                </MenuItem>
              ))
            ) : (
              <MenuItem disabled>No other sidebar folders</MenuItem>
            )}
            {branchContextProjects.length > 0 ? (
              <>
                <MenuSeparator className="mx-1" />
                {branchContextProjects.map((project) => (
                  <AddBranchContextSubmenu
                    key={`branch:${project.id}`}
                    project={project}
                    contexts={props.contexts}
                    onAddBranchContext={props.onAddBranchContext}
                  />
                ))}
              </>
            ) : null}
            {props.onBrowseFolder ? (
              <>
                <MenuSeparator className="mx-1" />
                <MenuItem
                  onClick={() => {
                    props.onBrowseFolder?.();
                  }}
                >
                  <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 truncate">Browse folder…</span>
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
    </div>
  );
}
