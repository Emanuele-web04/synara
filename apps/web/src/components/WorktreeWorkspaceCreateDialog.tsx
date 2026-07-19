import type {
  GitBranch,
  GitHubAccountSelection,
  GitPullRequestListFilter,
  GitPullRequestListItem,
  OrchestrationWorktreeWorkspace,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { readNativeApi } from "../nativeApi";
import { formatRelativeTime } from "../lib/relativeTime";
import { cn } from "../lib/utils";
import { CheckIcon, GitBranchIcon, GitPullRequestIcon, SearchIcon } from "../lib/icons";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  PULL_REQUEST_PICKER_FILTERS,
  pullRequestPickerScope,
} from "./pullRequest/pullRequestBrowser.logic";
import {
  filterPullRequestEntriesByInvolvement,
  pullRequestWorkspaceAssociation,
  type PullRequestWorkspaceAssociation,
} from "./pullRequest/pullRequestList.logic";
import { PullRequestAvatar } from "./pullRequest/PullRequestAvatar";
import { PullRequestDiffStat } from "./pullRequest/PullRequestDiffStat";
import { PullRequestFilterPillGroup } from "./pullRequest/PullRequestListFilters";
import { PullRequestStateGlyph } from "./pullRequest/PullRequestStateGlyph";
import {
  branchNameFromWorkspaceTitle,
  dedupeWorkspaceBranches,
  filterWorkspaceBranches,
  filterWorkspacePullRequests,
  readableWorkspaceBranchName,
} from "./WorktreeWorkspaceCreateDialog.logic";
import { Button } from "./ui/button";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { SlidingSegmentedControl } from "./ui/SlidingSegmentedControl";
import { Spinner } from "./ui/spinner";
import {
  pullRequestsExactInvolvementQueryOptions,
  pullRequestsListQueryOptions,
  shouldLoadExactPullRequestInvolvement,
} from "../lib/pullRequestReactQuery";
import { useStore } from "../store";

export type WorkspaceCreateSource =
  | { kind: "new-branch"; branchName: string; targetRef: string }
  | { kind: "branch"; sourceRef: string; targetRef: string }
  | { kind: "pull-request"; reference: string };

interface WorktreeWorkspaceCreateDialogProps {
  open: boolean;
  projectName: string;
  projectCwd: string;
  githubAccount?: GitHubAccountSelection;
  defaultTargetRef: string | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; source: WorkspaceCreateSource }) => Promise<void>;
}

const SOURCE_OPTIONS = [
  { value: "new-branch", label: "New branch" },
  { value: "branch", label: "Existing branch" },
  { value: "pull-request", label: "Pull request" },
] as const satisfies readonly { value: WorkspaceCreateSource["kind"]; label: string }[];

const EMPTY_WORKTREE_WORKSPACES: readonly OrchestrationWorktreeWorkspace[] = [];

function PullRequestRow({
  pullRequest,
  selected,
  workspaceAssociation,
  onSelect,
}: {
  pullRequest: GitPullRequestListItem;
  selected: boolean;
  workspaceAssociation: PullRequestWorkspaceAssociation;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 rounded-md px-2.5 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        selected
          ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
          : "text-foreground hover:bg-[var(--color-background-elevated-secondary)]/65",
      )}
      onClick={onSelect}
    >
      <span className="row-span-2">
        <PullRequestStateGlyph
          state={pullRequest.state}
          isDraft={pullRequest.isDraft}
          className="mt-0.5"
        />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-xs font-medium leading-4">{pullRequest.title}</span>
        {workspaceAssociation ? (
          <span className="shrink-0 rounded-full bg-foreground/7 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
            {workspaceAssociation === "archived" ? "Archived workspace" : "In Synara"}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums text-[10px] leading-4 text-muted-foreground">
        {pullRequest.updatedAt ? formatRelativeTime(pullRequest.updatedAt) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <PullRequestAvatar
          actor={
            pullRequest.authorLogin
              ? {
                  login: pullRequest.authorLogin,
                  name: null,
                  avatarUrl: pullRequest.authorAvatarUrl,
                  url: null,
                }
              : null
          }
        />
        <span className="min-w-0 truncate">
          {pullRequest.authorLogin ?? "Unknown author"}
          <span aria-hidden> · </span>
          {pullRequest.headBranch} → {pullRequest.baseBranch}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 tabular-nums text-[10px]">
        {pullRequest.additions !== null && pullRequest.deletions !== null ? (
          <PullRequestDiffStat
            additions={pullRequest.additions}
            deletions={pullRequest.deletions}
            tone="diff"
          />
        ) : null}
        {selected ? <CheckIcon className="size-3 text-foreground" aria-hidden /> : null}
      </span>
    </button>
  );
}

export function WorktreeWorkspaceCreateDialog({
  open,
  projectName,
  projectCwd,
  defaultTargetRef,
  onOpenChange,
  onCreate,
}: WorktreeWorkspaceCreateDialogProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const branchSearchRef = useRef<HTMLInputElement>(null);
  const pullRequestSearchRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("New workspace");
  const [titleTouched, setTitleTouched] = useState(false);
  const [branchName, setBranchName] = useState(branchNameFromWorkspaceTitle("New workspace"));
  const [branchNameTouched, setBranchNameTouched] = useState(false);
  const [sourceKind, setSourceKind] = useState<WorkspaceCreateSource["kind"]>("new-branch");
  const [targetRef, setTargetRef] = useState(defaultTargetRef ?? "HEAD");
  const [repositoryTargetRef, setRepositoryTargetRef] = useState(defaultTargetRef ?? "HEAD");
  const [branchQuery, setBranchQuery] = useState("");
  const [pullRequestQuery, setPullRequestQuery] = useState("");
  const [pullRequestFilter, setPullRequestFilter] = useState<GitPullRequestListFilter>("reviewing");
  const [pullRequestReference, setPullRequestReference] = useState("");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchListError, setBranchListError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = useStore(
    (store) => store.projects.find((project) => project.cwd === projectCwd)?.id ?? null,
  );
  const worktreeWorkspaces = useStore(
    (store) => store.worktreeWorkspaces ?? EMPTY_WORKTREE_WORKSPACES,
  );
  const pullRequestScope = pullRequestPickerScope(pullRequestFilter);
  const pullRequestQueryEnabled = open && sourceKind === "pull-request" && projectId !== null;
  const pullRequestListQuery = useQuery({
    ...pullRequestsListQueryOptions({ state: pullRequestScope.state, projectId }),
    enabled: pullRequestQueryEnabled,
  });
  const pullRequestSupersetTruncated = (pullRequestListQuery.data?.repositoryBatches ?? []).some(
    (batch) => batch.truncated,
  );
  const needsExactPullRequestInvolvement = shouldLoadExactPullRequestInvolvement({
    ...pullRequestScope,
    supersetTruncated: pullRequestSupersetTruncated,
  });
  const exactPullRequestListQuery = useQuery({
    ...pullRequestsExactInvolvementQueryOptions({
      ...pullRequestScope,
      projectId,
    }),
    enabled: pullRequestQueryEnabled && needsExactPullRequestInvolvement,
  });
  const activePullRequestList =
    needsExactPullRequestInvolvement && exactPullRequestListQuery.data
      ? exactPullRequestListQuery.data
      : pullRequestListQuery.data;
  const pullRequests = useMemo<GitPullRequestListItem[]>(
    () =>
      filterPullRequestEntriesByInvolvement(
        activePullRequestList?.entries ?? [],
        activePullRequestList?.viewer ?? pullRequestListQuery.data?.viewer,
        pullRequestScope.involvement,
      ).map((entry) => ({
        number: entry.number,
        title: entry.title,
        url: entry.url,
        baseBranch: entry.baseBranch,
        headBranch: entry.headBranch,
        state: entry.state,
        isDraft: entry.isDraft,
        authorLogin: entry.author?.login ?? null,
        authorAvatarUrl: entry.author?.avatarUrl ?? null,
        updatedAt: entry.updatedAt,
        additions: entry.additions,
        deletions: entry.deletions,
      })),
    [activePullRequestList, pullRequestListQuery.data?.viewer, pullRequestScope.involvement],
  );
  const isLoadingPullRequests =
    pullRequestQueryEnabled &&
    (pullRequestListQuery.isPending ||
      (needsExactPullRequestInvolvement && exactPullRequestListQuery.isPending));
  const pullRequestListError =
    (pullRequestListQuery.isError && pullRequestListQuery.error) ||
    (needsExactPullRequestInvolvement &&
      exactPullRequestListQuery.isError &&
      exactPullRequestListQuery.error) ||
    (pullRequestQueryEnabled ? null : new Error("This project is not available in the PR hub."));

  useEffect(() => {
    if (!open) return;
    setTitle("New workspace");
    setTitleTouched(false);
    setBranchName(branchNameFromWorkspaceTitle("New workspace"));
    setBranchNameTouched(false);
    setSourceKind("new-branch");
    setTargetRef(defaultTargetRef ?? "HEAD");
    setRepositoryTargetRef(defaultTargetRef ?? "HEAD");
    setBranchQuery("");
    setPullRequestQuery("");
    setPullRequestFilter("reviewing");
    setPullRequestReference("");
    setBranchListError(null);
    setError(null);
    setIsCreating(false);
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    });
    const api = readNativeApi();
    if (!api) return () => window.cancelAnimationFrame(frame);
    setIsLoadingBranches(true);
    void api.git
      .listBranches({ cwd: projectCwd })
      .then((result) => {
        if (cancelled) return;
        setBranches([...result.branches]);
        const preferred =
          result.branches.find((branch) => !branch.isRemote && branch.isDefault)?.name ??
          result.branches.find((branch) => !branch.isRemote && branch.current)?.name;
        setTargetRef(defaultTargetRef ?? preferred ?? "HEAD");
        setRepositoryTargetRef(defaultTargetRef ?? preferred ?? "HEAD");
      })
      .catch((cause) => {
        if (cancelled) return;
        setBranchListError(
          cause instanceof Error ? cause.message : "Branches could not be loaded. Try again.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBranches(false);
      });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [defaultTargetRef, open, projectCwd]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (sourceKind === "pull-request") pullRequestSearchRef.current?.focus();
      if (sourceKind === "branch") branchSearchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, sourceKind]);

  const branchOptions = useMemo(() => dedupeWorkspaceBranches(branches), [branches]);
  const selectedBranch = branchOptions.find((branch) => branch.name === targetRef) ?? null;
  const filteredBranchOptions = useMemo(
    () => filterWorkspaceBranches(branchOptions, branchQuery),
    [branchOptions, branchQuery],
  );
  const filteredPullRequests = useMemo(
    () => filterWorkspacePullRequests(pullRequests, pullRequestQuery),
    [pullRequestQuery, pullRequests],
  );
  const directPullRequestReference = parsePullRequestReference(pullRequestQuery);
  const visibleDirectPullRequestReference =
    directPullRequestReference &&
    !filteredPullRequests.some(
      (pullRequest) =>
        pullRequest.url === directPullRequestReference ||
        `#${pullRequest.number}` === directPullRequestReference ||
        String(pullRequest.number) === directPullRequestReference,
    )
      ? directPullRequestReference
      : null;
  const selectedPullRequest =
    pullRequests.find((pullRequest) => pullRequest.url === pullRequestReference) ?? null;
  const canCreate =
    title.trim().length > 0 &&
    (sourceKind === "pull-request"
      ? pullRequestReference.trim().length > 0
      : sourceKind === "new-branch"
        ? branchName.trim().length > 0 && repositoryTargetRef.trim().length > 0
        : targetRef.trim().length > 0 &&
          selectedBranch !== null &&
          selectedBranch.worktreePath == null) &&
    !isCreating;

  const createWorkspace = async () => {
    if (!canCreate) return;
    setIsCreating(true);
    setError(null);
    try {
      const source: WorkspaceCreateSource =
        sourceKind === "pull-request"
          ? { kind: sourceKind, reference: pullRequestReference.trim() }
          : sourceKind === "branch"
            ? {
                kind: sourceKind,
                sourceRef: targetRef.trim(),
                targetRef: repositoryTargetRef.trim(),
              }
            : {
                kind: sourceKind,
                branchName: branchName.trim(),
                targetRef: repositoryTargetRef.trim(),
              };
      await onCreate({ title: title.trim(), source });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be created.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup surface="solid" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            Start a focused worktree in {projectName} from a new branch, an existing branch, or a
            GitHub pull request.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4 !pt-2">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Workspace name</span>
            <Input
              ref={titleRef}
              value={title}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setTitle(nextTitle);
                setTitleTouched(true);
                if (!branchNameTouched) setBranchName(branchNameFromWorkspaceTitle(nextTitle));
              }}
            />
          </label>

          <fieldset className="grid gap-2.5">
            <legend className="text-xs font-medium text-foreground">Create from</legend>
            <SlidingSegmentedControl
              value={sourceKind}
              options={SOURCE_OPTIONS}
              ariaLabel="Workspace source"
              onValueChange={(nextSourceKind) => {
                setSourceKind(nextSourceKind);
                setError(null);
                if (nextSourceKind !== "pull-request") {
                  setPullRequestReference("");
                }
                if (nextSourceKind === "new-branch") {
                  setTargetRef(repositoryTargetRef);
                  setBranchQuery("");
                }
                if (nextSourceKind === "branch" && selectedBranch?.worktreePath) {
                  const availableBranch = branchOptions.find(
                    (branch) => branch.worktreePath == null,
                  );
                  setTargetRef(availableBranch?.name ?? "");
                }
              }}
            />
          </fieldset>

          <DisclosureRegion open={sourceKind === "new-branch"}>
            <div className="grid gap-2">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Branch name</span>
                <Input
                  value={branchName}
                  placeholder="synara/feature-name"
                  spellCheck={false}
                  onChange={(event) => {
                    setBranchName(event.target.value);
                    setBranchNameTouched(true);
                    setError(null);
                  }}
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Creates this branch from {repositoryTargetRef}.
              </p>
            </div>
          </DisclosureRegion>

          {sourceKind === "pull-request" ? (
            <div className="grid gap-2.5">
              <div className="overflow-x-auto pb-0.5" aria-label="Pull request filters">
                <PullRequestFilterPillGroup
                  value={pullRequestFilter}
                  options={PULL_REQUEST_PICKER_FILTERS}
                  onChange={(filter) => {
                    setPullRequestFilter(filter);
                    setPullRequestReference("");
                    setError(null);
                  }}
                />
              </div>

              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Pull requests</span>
                <span className="relative block">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={pullRequestSearchRef}
                    type="search"
                    value={pullRequestQuery}
                    placeholder="Search title, author, branch, URL, or number"
                    className="[&_input]:pl-8"
                    onChange={(event) => {
                      setPullRequestQuery(event.target.value);
                      setPullRequestReference("");
                      setError(null);
                    }}
                  />
                </span>
              </label>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-background/35 p-1">
                {isLoadingPullRequests ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Loading pull requests…
                  </div>
                ) : pullRequestListError ? (
                  <div className="grid gap-1 px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                    <p>Pull requests could not be loaded.</p>
                    <p className="text-[11px]">
                      {pullRequestListError instanceof Error
                        ? pullRequestListError.message
                        : "Check GitHub CLI and try again."}
                    </p>
                  </div>
                ) : filteredPullRequests.length === 0 && !visibleDirectPullRequestReference ? (
                  <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                    {pullRequests.length === 0
                      ? "No pull requests found for this filter."
                      : "No pull requests match your search."}
                  </div>
                ) : (
                  <div className="grid gap-0.5">
                    {visibleDirectPullRequestReference ? (
                      <button
                        type="button"
                        aria-pressed={pullRequestReference === visibleDirectPullRequestReference}
                        className={cn(
                          "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          pullRequestReference === visibleDirectPullRequestReference
                            ? "bg-[var(--color-background-elevated-secondary)]"
                            : "hover:bg-[var(--color-background-elevated-secondary)]/65",
                        )}
                        onClick={() => {
                          setPullRequestReference(visibleDirectPullRequestReference);
                          setError(null);
                        }}
                      >
                        <GitPullRequestIcon className="size-4 text-muted-foreground" />
                        <span className="min-w-0 truncate text-xs font-medium">
                          Use {visibleDirectPullRequestReference}
                        </span>
                        {pullRequestReference === visibleDirectPullRequestReference ? (
                          <CheckIcon className="size-3" />
                        ) : null}
                      </button>
                    ) : null}
                    {filteredPullRequests.map((pullRequest) => (
                      <PullRequestRow
                        key={pullRequest.url}
                        pullRequest={pullRequest}
                        selected={pullRequestReference === pullRequest.url}
                        workspaceAssociation={
                          projectId
                            ? pullRequestWorkspaceAssociation(
                                {
                                  projectId,
                                  number: pullRequest.number,
                                  url: pullRequest.url,
                                },
                                worktreeWorkspaces,
                              )
                            : null
                        }
                        onSelect={() => {
                          setPullRequestReference(pullRequest.url);
                          if (!titleTouched) {
                            setTitle(pullRequest.title);
                            setBranchName(branchNameFromWorkspaceTitle(pullRequest.title));
                          }
                          setError(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {selectedPullRequest ? (
                <p className="text-[11px] text-muted-foreground">
                  The workspace will track <strong>{selectedPullRequest.headBranch}</strong> and
                  target <strong>{selectedPullRequest.baseBranch}</strong>.
                </p>
              ) : null}
            </div>
          ) : null}

          <DisclosureRegion open={sourceKind === "branch"}>
            <div className="grid gap-2">
              <label className="grid gap-1.5" htmlFor="workspace-branch-search">
                <span className="text-xs font-medium text-foreground">Starting branch</span>
                <span className="relative block">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="workspace-branch-search"
                    ref={branchSearchRef}
                    type="search"
                    value={branchQuery}
                    placeholder="Search branches"
                    className="[&_input]:pl-8"
                    disabled={isLoadingBranches}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      setBranchQuery(nextQuery);
                      if (
                        selectedBranch &&
                        filterWorkspaceBranches([selectedBranch], nextQuery).length === 0
                      ) {
                        setTargetRef("");
                      }
                      setError(null);
                    }}
                  />
                </span>
              </label>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background/35 p-1">
                {isLoadingBranches ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Loading branches…
                  </div>
                ) : branchListError ? (
                  <div className="grid gap-1 px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                    <p>Branches could not be loaded.</p>
                    <p className="text-[11px]">{branchListError}</p>
                  </div>
                ) : filteredBranchOptions.length === 0 ? (
                  <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No branches match your search.
                  </div>
                ) : (
                  <div className="grid gap-0.5">
                    {filteredBranchOptions.map((branch) => {
                      const selected = branch.name === targetRef;
                      const unavailable = branch.worktreePath != null;
                      return (
                        <button
                          key={`${branch.isRemote ? "remote" : "local"}:${branch.name}`}
                          type="button"
                          disabled={unavailable}
                          aria-pressed={selected}
                          className={cn(
                            "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                            selected
                              ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
                              : "text-foreground hover:bg-[var(--color-background-elevated-secondary)]/65",
                            unavailable && "cursor-not-allowed opacity-45",
                          )}
                          onClick={() => {
                            setTargetRef(branch.name);
                            setError(null);
                          }}
                        >
                          <GitBranchIcon className="size-3.5 text-muted-foreground" />
                          <span className="min-w-0 truncate text-xs font-medium">
                            {readableWorkspaceBranchName(branch)}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                            {branch.isDefault ? <span>Default</span> : null}
                            {branch.isRemote ? <span>Remote</span> : null}
                            {unavailable ? <span>In another worktree</span> : null}
                            {selected ? <CheckIcon className="size-3 text-foreground" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </DisclosureRegion>

          {sourceKind === "branch" ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Synara checks out this branch and targets {repositoryTargetRef}. Branches already used
              by another worktree stay unavailable to prevent Git conflicts.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs leading-relaxed text-red-400">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={() => void createWorkspace()}>
            {isCreating ? <Spinner className="size-3.5" /> : null}
            {isCreating ? "Creating workspace…" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
