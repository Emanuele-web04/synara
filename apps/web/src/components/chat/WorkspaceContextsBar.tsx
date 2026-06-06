import type { ProjectId, ThreadWorkspaceContext } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  isPendingThreadWorktree,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceState,
} from "@t3tools/shared/threadEnvironment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LuSplit } from "react-icons/lu";
import { useCallback, useMemo } from "react";
import { CentralIcon } from "~/lib/central-icons";
import { XIcon } from "~/lib/icons";

import { gitBranchesQueryOptions, gitCreateWorktreeMutationOptions } from "../../lib/gitReactQuery";
import { cn } from "../../lib/utils";
import type { Project, ThreadWorkspacePatch } from "../../types";
import {
  resolveEffectiveEnvMode,
  type EnvMode,
} from "../BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

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
    enabled: Boolean(projectCwd) && !props.isPrimary,
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

  const showBranchControls = !props.isPrimary && isGitRepo && projectCwd;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5",
        props.isPrimary
          ? "border-primary/35 bg-primary/10 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
        isPendingWorktree && "border-amber-500/40 bg-amber-500/10",
      )}
      title={props.context.cwd ?? projectCwd ?? label}
    >
      <span className="max-w-32 truncate">{label}</span>
      {props.isPrimary && props.context.branch ? (
        <span className="text-muted-foreground">({props.context.branch})</span>
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
        <span className="rounded-full bg-background/70 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          primary
        </span>
      ) : (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={props.onMakePrimary}
        >
          Make primary
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

export function WorkspaceContextsBar(props: {
  projects: readonly Project[];
  contexts: readonly ThreadWorkspaceContext[];
  activeContextId: string | null;
  onAddProjectContext: (projectId: ProjectId) => void;
  onRemoveContext: (contextId: string) => void;
  onMakePrimary: (contextId: string) => void;
  onUpdateContext: (
    contextId: string,
    patch: Pick<ThreadWorkspacePatch, "branch" | "worktreePath" | "envMode">,
  ) => void;
}) {
  const selectedProjectIds = useMemo(
    () => new Set(props.contexts.map((context) => context.projectId)),
    [props.contexts],
  );
  const availableProjects = useMemo(
    () =>
      props.projects.filter(
        (project) => project.kind === "project" && !selectedProjectIds.has(project.id),
      ),
    [props.projects, selectedProjectIds],
  );
  const activeContextId = props.activeContextId ?? props.contexts[0]?.id ?? null;

  return (
    <div className="flex min-h-9 items-center gap-2 border-b border-border/50 px-4 py-1.5 text-xs">
      <span className="text-muted-foreground">Context</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {props.contexts.map((context) => {
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
      </div>
      <select
        className="max-w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none hover:bg-muted/40 disabled:opacity-50"
        value=""
        disabled={availableProjects.length === 0}
        aria-label="Add workspace context"
        onChange={(event) => {
          const projectId = event.currentTarget.value as ProjectId;
          if (projectId) {
            props.onAddProjectContext(projectId);
            event.currentTarget.value = "";
          }
        }}
      >
        <option value="">Add context</option>
        {availableProjects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name || project.folderName}
          </option>
        ))}
      </select>
    </div>
  );
}
