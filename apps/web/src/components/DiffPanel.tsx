// Note: raw <button>s in this file are intentional — turn-strip nav arrows
// (translucent absolute-positioned scrollers), turn chips (selectable tab-like
// chips with custom inner-div styling), and Summary/Review/Total tabs are
// specialized affordances that don't fit the shadcn Button taxonomy. The
// generic close affordance is the IconButton variant chrome instance below.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import { FaPlusMinus } from "react-icons/fa6";
import { LuWrapText } from "react-icons/lu";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  DiffIcon,
  AdjustmentsIcon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "~/lib/icons";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  gitSummarizeDiffQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getRenderablePatch,
  resolveDiffCopyText,
  resolveFileDiffPath,
  sortFileDiffsByPath,
  summarizePatchStats,
} from "../lib/diffRendering";
import { resolveDiffEnvironmentState } from "../lib/threadEnvironment";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import {
  isRepoDiffScope,
  REPO_DIFF_SCOPE_LABELS,
  useRepoDiffScopeStore,
} from "../repoDiffScopeStore";
import { useStore } from "../store";
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import { getProviderStartOptions, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { formatShortTimestamp } from "../timestampFormat";
import ChatMarkdown from "./ChatMarkdown";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chat/chatHeaderControls";
import { resolveDiffPanelThread } from "./DiffPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { DiffStat } from "./chat/DiffStatLabel";
import { FileDiffCard, FileDiffSurface } from "./chat/FileDiffView";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { type SplitViewPanePanelState } from "../splitViewStore";
import { hasLiveTurnTailWork, isLatestTurnSettled } from "../session-logic";

type DiffRenderMode = "stacked" | "split";
type DiffSurfaceMode = "review" | "summary" | "total";

interface DiffPanelProps {
  mode?: DiffPanelMode;
  threadId?: ThreadId | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  threadId: controlledThreadId,
  panelState,
  onUpdatePanelState,
  onClosePanel,
  liveRefreshEnabled = true,
}: DiffPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const providerOptions = useMemo(() => getProviderStartOptions(settings), [settings]);
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(true);
  const [surfaceMode, setSurfaceMode] = useState<DiffSurfaceMode>("review");
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const setRepoDiffScope = useRepoDiffScopeStore((store) => store.setScope);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = panelState ? panelState.panel === "diff" : diffSearch.diff === "1";
  const activeThreadId = controlledThreadId ?? routeThreadId;
  const serverThread = useStore(
    useMemo(() => createThreadSelector(activeThreadId), [activeThreadId]),
  );
  const draftThread = useComposerDraftStore((store) =>
    activeThreadId ? (store.draftThreadsByThreadId[activeThreadId] ?? null) : null,
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  // Keep diff summary access available for draft chats before the first turn promotes them into the server store.
  const activeThread = useMemo(
    () =>
      resolveDiffPanelThread({
        threadId: activeThreadId,
        serverThread,
        draftThread,
        fallbackModelSelection: fallbackDraftProject?.defaultModelSelection ?? null,
      }),
    [activeThreadId, draftThread, fallbackDraftProject?.defaultModelSelection, serverThread],
  );
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const resolvedThreadEnvMode =
    serverThread?.envMode ?? draftThread?.envMode ?? activeThread?.envMode;
  const resolvedThreadWorktreePath =
    serverThread?.worktreePath ?? draftThread?.worktreePath ?? activeThread?.worktreePath ?? null;
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const activeCwd = diffEnvironmentState.cwd;
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const gitStatusQuery = useQuery(gitStatusQueryOptions(activeCwd ?? null));
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const repoDiffLiveRefreshIntervalMs = useMemo(() => {
    if (!liveRefreshEnabled) return false;
    if (!activeThread) return false;
    const hasLiveTail = hasLiveTurnTailWork({
      latestTurn: activeThread.latestTurn,
      messages: activeThread.messages,
      activities: activeThread.activities,
      session: activeThread.session,
    });
    return !isLatestTurnSettled(activeThread.latestTurn, activeThread.session) || hasLiveTail
      ? GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS
      : false;
  }, [activeThread, liveRefreshEnabled]);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = panelState
    ? (panelState.diffTurnId ?? null)
    : (diffSearch.diffTurnId ?? null);
  const selectedFilePath =
    selectedTurnId !== null
      ? panelState
        ? (panelState.diffFilePath ?? null)
        : (diffSearch.diffFilePath ?? null)
      : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && !diffEnvironmentPending,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const normalizedSelectedPatch = hasResolvedPatch ? selectedPatch.trim() : null;
  const repoDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: repoDiffScope,
      enabled: diffOpen && !diffEnvironmentPending,
      refetchInterval: repoDiffLiveRefreshIntervalMs,
    }),
  );
  const repoPatch = repoDiffQuery.data?.patch;
  const hasResolvedRepoPatch = typeof repoPatch === "string";
  const hasNoRepoChanges = hasResolvedRepoPatch && repoPatch.trim().length === 0;
  const normalizedRepoPatch = hasResolvedRepoPatch ? repoPatch.trim() : null;
  const repoDiffError =
    repoDiffQuery.error instanceof Error
      ? repoDiffQuery.error.message
      : repoDiffQuery.error
        ? "Failed to load repo diff."
        : null;
  const branchHasCommittedChanges = (gitStatusQuery.data?.aheadCount ?? 0) > 0;

  useEffect(() => {
    if (!hasResolvedRepoPatch || !activeCwd) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(activeCwd) });
    void queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(activeCwd) });
  }, [activeCwd, hasResolvedRepoPatch, queryClient, repoPatch]);

  useEffect(() => {
    if (
      diffOpen &&
      repoDiffScope === "workingTree" &&
      hasResolvedRepoPatch &&
      hasNoRepoChanges &&
      branchHasCommittedChanges
    ) {
      setRepoDiffScope("branch");
      setSurfaceMode("total");
    }
  }, [
    branchHasCommittedChanges,
    diffOpen,
    hasNoRepoChanges,
    hasResolvedRepoPatch,
    repoDiffScope,
    setRepoDiffScope,
  ]);

  const activeReviewPatch = surfaceMode === "total" ? repoPatch : selectedPatch;
  const activeReviewError = surfaceMode === "total" ? repoDiffError : checkpointDiffError;
  const activeReviewIsLoading =
    surfaceMode === "total" ? repoDiffQuery.isLoading : isLoadingCheckpointDiff;
  const activeReviewHasNoChanges = surfaceMode === "total" ? hasNoRepoChanges : hasNoNetChanges;
  const isSidebarMode = mode === "sidebar";
  const { copyToClipboard, isCopied: isSummaryCopied } = useCopyToClipboard();
  const { copyToClipboard: copyDiffToClipboard, isCopied: isDiffCopied } = useCopyToClipboard();
  const diffCopyText = useMemo(() => resolveDiffCopyText(activeReviewPatch), [activeReviewPatch]);
  const renderablePatch = useMemo(
    () => getRenderablePatch(activeReviewPatch, `diff-panel:${resolvedTheme}`),
    [activeReviewPatch, resolvedTheme],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return sortFileDiffsByPath(renderablePatch.files);
  }, [renderablePatch]);
  const totalPatchStat = useMemo(() => summarizePatchStats(repoPatch), [repoPatch]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setSurfaceMode("review");
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  const selectedPatchIdentity = useMemo(
    () =>
      normalizedSelectedPatch && normalizedSelectedPatch.length > 0
        ? buildPatchCacheKey(normalizedSelectedPatch, "diff-panel:surface")
        : null,
    [normalizedSelectedPatch],
  );
  const diffSummaryCacheScope = useMemo(() => {
    if (!activeProjectId) {
      return activeCwd ?? null;
    }

    // Share summaries across chats in the same project, while isolating worktrees.
    return activeThread?.worktreePath
      ? `project:${activeProjectId}:worktree:${activeThread.worktreePath}`
      : `project:${activeProjectId}:local`;
  }, [activeCwd, activeProjectId, activeThread?.worktreePath]);

  useEffect(() => {
    if (surfaceMode === "summary" && hasResolvedRepoPatch && hasNoRepoChanges) {
      setSurfaceMode("review");
    }
  }, [hasNoRepoChanges, hasResolvedRepoPatch, surfaceMode]);

  useEffect(() => {
    setSurfaceMode("review");
  }, [activeThreadId, diffOpen, selectedPatchIdentity, selectedTurnId]);

  const diffSummaryPrefetchOptions = useMemo(
    () =>
      gitSummarizeDiffQueryOptions({
        cwd: activeCwd ?? null,
        cacheScope: diffSummaryCacheScope,
        patch: normalizedRepoPatch,
        codexHomePath: settings.codexHomePath || null,
        model: settings.textGenerationModel ?? null,
        ...(providerOptions ? { providerOptions } : {}),
        enabled: true,
      }),
    [
      activeCwd,
      diffSummaryCacheScope,
      normalizedRepoPatch,
      settings.codexHomePath,
      settings.textGenerationModel,
      providerOptions,
    ],
  );
  const diffSummaryQueryOptions = useMemo(
    () =>
      gitSummarizeDiffQueryOptions({
        cwd: activeCwd ?? null,
        cacheScope: diffSummaryCacheScope,
        patch: normalizedRepoPatch,
        codexHomePath: settings.codexHomePath || null,
        model: settings.textGenerationModel ?? null,
        ...(providerOptions ? { providerOptions } : {}),
        enabled: surfaceMode === "summary",
      }),
    [
      activeCwd,
      diffSummaryCacheScope,
      normalizedRepoPatch,
      settings.codexHomePath,
      settings.textGenerationModel,
      providerOptions,
      surfaceMode,
    ],
  );
  const diffSummaryQuery = useQuery(diffSummaryQueryOptions);
  const diffSummaryText = diffSummaryQuery.data?.summary ?? null;
  const diffSummaryError =
    diffSummaryQuery.error instanceof Error
      ? diffSummaryQuery.error.message
      : diffSummaryQuery.error
        ? "Failed to generate diff summary."
        : null;
  const canShowSummary = Boolean(
    !diffEnvironmentPending && activeCwd && (!hasResolvedRepoPatch || !hasNoRepoChanges),
  );
  const canPrefetchSummary = Boolean(
    diffOpen && !diffEnvironmentPending && activeCwd && normalizedRepoPatch && !hasNoRepoChanges,
  );
  const canShowTotal = Boolean(!diffEnvironmentPending && activeCwd);

  useEffect(() => {
    if (!canPrefetchSummary) {
      return;
    }

    const cachedSummaryState = queryClient.getQueryState(diffSummaryPrefetchOptions.queryKey);
    if (
      cachedSummaryState?.status === "success" ||
      cachedSummaryState?.fetchStatus === "fetching"
    ) {
      return;
    }

    const timerId = window.setTimeout(() => {
      const nextSummaryState = queryClient.getQueryState(diffSummaryPrefetchOptions.queryKey);
      if (nextSummaryState?.status === "success" || nextSummaryState?.fetchStatus === "fetching") {
        return;
      }
      void queryClient.prefetchQuery(diffSummaryPrefetchOptions);
    }, 900);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [canPrefetchSummary, diffSummaryPrefetchOptions, queryClient]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  }, []);

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    if (onUpdatePanelState) {
      onUpdatePanelState({
        panel: "diff",
        diffTurnId: turnId,
        diffFilePath: null,
      });
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, panel: "diff", diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    if (onUpdatePanelState) {
      onUpdatePanelState({
        panel: "diff",
        diffTurnId: null,
        diffFilePath: null,
      });
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, panel: "diff", diff: "1" };
      },
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {canScrollTurnStripLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-[var(--color-background-surface)] to-transparent" />
        )}
        {canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-[var(--color-background-surface)] to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-[var(--color-background-surface)] text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-[var(--color-background-surface)] text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-[color:var(--color-border)] bg-[var(--color-text-foreground)] text-[var(--color-background-surface)]"
                  : "border-[color:var(--color-border-light)] bg-transparent text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--color-text-foreground)]",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-[color:var(--color-border)] bg-[var(--color-text-foreground)] text-[var(--color-background-surface)]"
                    : "border-[color:var(--color-border-light)] bg-transparent text-[var(--color-text-foreground-secondary)] hover:border-[color:var(--color-border)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--color-text-foreground)]",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {!isSidebarMode ? (
          <>
            <ToggleGroup
              className="shrink-0"
              variant="outline"
              size="xs"
              value={[diffRenderMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "stacked" || next === "split") {
                  setDiffRenderMode(next);
                }
              }}
            >
              <Toggle aria-label="Stacked diff view" value="stacked">
                <Rows3Icon className="size-3" />
              </Toggle>
              <Toggle aria-label="Split diff view" value="split">
                <Columns2Icon className="size-3" />
              </Toggle>
            </ToggleGroup>
            <Toggle
              aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
              title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
              variant="outline"
              size="xs"
              pressed={diffWordWrap}
              onPressedChange={(pressed) => {
                setDiffWordWrap(Boolean(pressed));
              }}
            >
              <TextWrapIcon className="size-3" />
            </Toggle>
          </>
        ) : null}
        {onClosePanel ? (
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="Close file view"
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "[-webkit-app-region:no-drag]")}
            onClick={(event) => {
              event.stopPropagation();
              onClosePanel();
            }}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <PanelStateMessage density="compact" fill="flex">
          Select a thread to inspect turn diffs.
        </PanelStateMessage>
      ) : !isGitRepo ? (
        <PanelStateMessage density="compact" fill="flex">
          Turn diffs are unavailable because this project is not a git repository.
        </PanelStateMessage>
      ) : diffEnvironmentPending ? (
        <PanelStateMessage density="compact" fill="flex">
          This chat environment is still being prepared. Diff and summary will be available once the
          worktree is ready.
        </PanelStateMessage>
      ) : (
        <>
          <div className="border-b border-border/70 px-3">
            <div className="flex items-end gap-1">
              <button
                type="button"
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium tracking-[-0.01em] transition-colors",
                  surfaceMode === "summary"
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                  !canShowSummary && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
                )}
                disabled={!canShowSummary}
                onClick={() => {
                  setSurfaceMode("summary");
                }}
                aria-pressed={surfaceMode === "summary"}
              >
                <LuWrapText className="size-3.5 opacity-80" />
                <span>Summary</span>
              </button>
              <button
                type="button"
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium tracking-[-0.01em] transition-colors",
                  surfaceMode === "review"
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setSurfaceMode("review");
                }}
                aria-pressed={surfaceMode === "review"}
              >
                <span className="inline-flex size-4 items-center justify-center rounded-[4px]">
                  <FaPlusMinus className="size-2.25 text-[var(--color-text-foreground)]" />
                </span>
                <span>Review</span>
              </button>
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      className={cn(
                        "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium tracking-[-0.01em] transition-colors",
                        surfaceMode === "total"
                          ? "border-foreground text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                        !canShowTotal &&
                          "cursor-not-allowed opacity-45 hover:text-muted-foreground",
                      )}
                      disabled={!canShowTotal}
                      onClick={() => {
                        setSurfaceMode("total");
                      }}
                      aria-pressed={surfaceMode === "total"}
                      aria-label="Choose repo diff source"
                    />
                  }
                >
                  <DiffIcon className="size-3.5 opacity-80" />
                  <span>{REPO_DIFF_SCOPE_LABELS[repoDiffScope]}</span>
                  {totalPatchStat ? (
                    <DiffStat
                      additions={totalPatchStat.additions}
                      deletions={totalPatchStat.deletions}
                      className="ml-0.5 inline-flex items-center text-[11px] font-medium"
                    />
                  ) : null}
                  <ChevronDownIcon className="size-3 opacity-70" />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup
                    value={repoDiffScope}
                    onValueChange={(value) => {
                      if (isRepoDiffScope(value)) {
                        setRepoDiffScope(value);
                        setSurfaceMode("total");
                      }
                    }}
                  >
                    <MenuRadioItem value="branch">Branch</MenuRadioItem>
                    <MenuRadioItem value="workingTree">Working tree</MenuRadioItem>
                    <MenuRadioItem value="unstaged">Unstaged</MenuRadioItem>
                    <MenuRadioItem value="staged">Staged</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              {surfaceMode === "review" ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="ml-auto shrink-0 self-center"
                        aria-label="Diff view options"
                        title="Diff view options"
                      />
                    }
                  >
                    <AdjustmentsIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuCheckboxItem
                      checked={diffIgnoreWhitespace}
                      variant="switch"
                      onCheckedChange={(checked) => {
                        setDiffIgnoreWhitespace(checked === true);
                      }}
                    >
                      Ignore whitespace-only changes
                    </MenuCheckboxItem>
                  </MenuPopup>
                </Menu>
              ) : null}
              {surfaceMode !== "summary" && diffCopyText ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className={cn(
                    "shrink-0 gap-1.5 self-center",
                    surfaceMode !== "review" && "ml-auto",
                  )}
                  onClick={() => {
                    copyDiffToClipboard(diffCopyText, undefined);
                  }}
                  aria-label={isDiffCopied ? "Copied full diff" : "Copy full diff"}
                  title={isDiffCopied ? "Copied full diff" : "Copy full diff"}
                >
                  {isDiffCopied ? (
                    <CheckIcon className="size-3 text-success" />
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                  <span>{isDiffCopied ? "Copied" : "Copy"}</span>
                </Button>
              ) : null}
            </div>
          </div>

          {surfaceMode === "summary" ? (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-border/60 pb-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Repo summary</p>
                  <p className="text-[11px] text-muted-foreground">
                    Generated from the current {REPO_DIFF_SCOPE_LABELS[repoDiffScope].toLowerCase()}{" "}
                    diff.
                  </p>
                </div>
                {diffSummaryText ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 gap-1.5"
                    onClick={() => {
                      copyToClipboard(diffSummaryText, undefined);
                    }}
                    aria-label={isSummaryCopied ? "Copied diff summary" : "Copy diff summary"}
                    title={isSummaryCopied ? "Copied diff summary" : "Copy diff summary"}
                  >
                    {isSummaryCopied ? (
                      <CheckIcon className="size-3 text-success" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                    <span>{isSummaryCopied ? "Copied" : "Copy"}</span>
                  </Button>
                ) : null}
              </div>

              {repoDiffQuery.isLoading && !hasResolvedRepoPatch ? (
                <DiffPanelLoadingState
                  label={`Loading ${REPO_DIFF_SCOPE_LABELS[repoDiffScope].toLowerCase()} diff...`}
                />
              ) : repoDiffError ? (
                <Alert variant="error" size="sm" className="text-destructive">
                  {repoDiffError}
                </Alert>
              ) : hasNoRepoChanges ? (
                <PanelStateMessage density="compact">
                  No changes in the selected diff source.
                </PanelStateMessage>
              ) : diffSummaryQuery.isLoading ? (
                <DiffPanelLoadingState label="Generating repo summary..." />
              ) : diffSummaryError ? (
                <Alert variant="error" size="sm" className="text-destructive">
                  {diffSummaryError}
                </Alert>
              ) : diffSummaryText ? (
                <ChatMarkdown
                  text={diffSummaryText}
                  cwd={activeCwd ?? undefined}
                  className="text-sm leading-7"
                />
              ) : (
                <PanelStateMessage density="compact">
                  Summary unavailable for the selected repo diff.
                </PanelStateMessage>
              )}
            </div>
          ) : (
            <div
              ref={patchViewportRef}
              className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {activeReviewError && !renderablePatch && (
                <div className="px-3">
                  <p className="mb-2 text-[11px] text-red-500/80">{activeReviewError}</p>
                </div>
              )}
              {!renderablePatch ? (
                activeReviewIsLoading ? (
                  <DiffPanelLoadingState
                    label={
                      surfaceMode === "total"
                        ? `Loading ${REPO_DIFF_SCOPE_LABELS[repoDiffScope].toLowerCase()} diff...`
                        : "Loading checkpoint diff..."
                    }
                  />
                ) : (
                  <PanelStateMessage density="compact">
                    <p>
                      {activeReviewHasNoChanges
                        ? surfaceMode === "total"
                          ? "No changes in the selected diff source."
                          : "No net changes in this selection."
                        : surfaceMode === "total"
                          ? "No repo diff is available right now."
                          : "No patch available for this selection."}
                    </p>
                  </PanelStateMessage>
                )
              ) : renderablePatch.kind === "files" ? (
                <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
                  {renderableFiles.map((fileDiff) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    const fileKey = buildFileDiffRenderKey(fileDiff);
                    const themedFileKey = `${fileKey}:${resolvedTheme}`;
                    const isCollapsed = collapsedFiles.has(fileKey);
                    return (
                      <div
                        key={themedFileKey}
                        data-diff-file-path={filePath}
                        className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                        onClickCapture={(event) => {
                          const nativeEvent = event.nativeEvent as MouseEvent;
                          const composedPath = nativeEvent.composedPath?.() ?? [];
                          const clickedHeader = composedPath.some((node) => {
                            if (!(node instanceof Element)) return false;
                            return (
                              node.hasAttribute("data-diffs-header") ||
                              node.hasAttribute("data-file-info")
                            );
                          });
                          if (!clickedHeader) return;
                          event.stopPropagation();
                          toggleFileCollapsed(fileKey);
                        }}
                      >
                        <FileDiffCard
                          fileDiff={fileDiff}
                          theme={resolvedTheme}
                          diffStyle={diffRenderMode === "split" ? "split" : "unified"}
                          overflow={diffWordWrap ? "wrap" : "scroll"}
                          collapsed={isCollapsed}
                          renderHeaderMetadata={() => (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                padding: "2px",
                                color: "inherit",
                              }}
                            >
                              <ChevronDownIcon
                                style={{
                                  width: "14px",
                                  height: "14px",
                                  transition: "transform 150ms ease",
                                  transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                                  opacity: 0.5,
                                }}
                              />
                            </span>
                          )}
                        />
                      </div>
                    );
                  })}
                </FileDiffSurface>
              ) : (
                <div className="h-full overflow-auto p-2">
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                    <pre
                      className={cn(
                        "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                        diffWordWrap
                          ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                          : "overflow-auto",
                      )}
                    >
                      {renderablePatch.text}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </DiffPanelShell>
  );
}
