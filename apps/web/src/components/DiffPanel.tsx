import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import {
  isPendingThreadWorktree,
  resolveThreadWorkspaceCwd,
} from "@t3tools/shared/threadEnvironment";
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
  gitBranchesQueryOptions,
  gitSummarizeDiffQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import { useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { formatShortTimestamp } from "../timestampFormat";
import ChatMarkdown from "./ChatMarkdown";
import { resolveDiffPanelThread } from "./DiffPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { type SplitViewPanePanelState } from "../splitViewStore";

type DiffRenderMode = "stacked" | "split";
type DiffSurfaceMode = "review" | "summary" | "total";
type DiffThemeType = "light" | "dark";

function buildDiffPanelUnsafeCSS(theme: "light" | "dark"): string {
  const titleColor = theme === "dark" ? "#6073CC" : "#526FFF";
  return `
:host {
  /* Route the entire diff viewer through the chat code font so custom code fonts reach line numbers too. */
  --diffs-font-family: var(--font-chat-code-family);
  --diffs-header-font-family: var(--font-chat-code-family);
  font-family: var(--font-chat-code-family) !important;
}

[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  /* Re-assert the code font inside the library chrome because these nodes live in shadow-rooted markup. */
  --diffs-font-family: var(--font-chat-code-family) !important;
  --diffs-header-font-family: var(--font-chat-code-family) !important;
  font-family: var(--font-chat-code-family) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  font-family: var(--font-chat-code-family) !important;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
  cursor: pointer;
}

/* Hide the default change-type icon (blue circle) — replaced by chevron + file-type icon. */
[data-change-icon] {
  display: none;
}

[data-title] {
  font-family: var(--font-chat-code-family) !important;
  cursor: pointer;
  color: ${titleColor} !important;
}
`;
}

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  threadId?: ThreadId | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  threadId: controlledThreadId,
  panelState,
  onUpdatePanelState,
  onClosePanel,
}: DiffPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [surfaceMode, setSurfaceMode] = useState<DiffSurfaceMode>("review");
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
  const diffEnvironmentPending = isPendingThreadWorktree({
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const activeCwd = diffEnvironmentPending
    ? null
    : resolveThreadWorkspaceCwd({
        projectCwd: activeProject?.cwd ?? null,
        envMode: resolvedThreadEnvMode,
        worktreePath: resolvedThreadWorktreePath,
      });
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
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
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      enabled: diffOpen && surfaceMode !== "review" && !diffEnvironmentPending,
    }),
  );
  const workingTreePatch = workingTreeDiffQuery.data?.patch;
  const hasResolvedWorkingTreePatch = typeof workingTreePatch === "string";
  const hasNoWorkingTreeChanges =
    hasResolvedWorkingTreePatch && workingTreePatch.trim().length === 0;
  const normalizedWorkingTreePatch = hasResolvedWorkingTreePatch ? workingTreePatch.trim() : null;
  const workingTreeDiffError =
    workingTreeDiffQuery.error instanceof Error
      ? workingTreeDiffQuery.error.message
      : workingTreeDiffQuery.error
        ? "Failed to load total working tree diff."
        : null;
  const activeReviewPatch = surfaceMode === "total" ? workingTreePatch : selectedPatch;
  const activeReviewError = surfaceMode === "total" ? workingTreeDiffError : checkpointDiffError;
  const activeReviewIsLoading =
    surfaceMode === "total" ? workingTreeDiffQuery.isLoading : isLoadingCheckpointDiff;
  const activeReviewHasNoChanges =
    surfaceMode === "total" ? hasNoWorkingTreeChanges : hasNoNetChanges;
  const isSidebarMode = mode === "sidebar";
  const { copyToClipboard, isCopied: isSummaryCopied } = useCopyToClipboard();
  const renderablePatch = useMemo(
    () => getRenderablePatch(activeReviewPatch, `diff-panel:${resolvedTheme}`),
    [activeReviewPatch, resolvedTheme],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

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
    if (surfaceMode === "summary" && hasResolvedWorkingTreePatch && hasNoWorkingTreeChanges) {
      setSurfaceMode("review");
    }
  }, [hasNoWorkingTreeChanges, hasResolvedWorkingTreePatch, surfaceMode]);

  useEffect(() => {
    setSurfaceMode("review");
  }, [activeThreadId, diffOpen, selectedPatchIdentity, selectedTurnId]);

  const diffSummaryPrefetchOptions = useMemo(
    () =>
      gitSummarizeDiffQueryOptions({
        cwd: activeCwd ?? null,
        cacheScope: diffSummaryCacheScope,
        patch: normalizedWorkingTreePatch,
        codexHomePath: settings.codexHomePath || null,
        model: settings.textGenerationModel ?? null,
        enabled: true,
      }),
    [
      activeCwd,
      diffSummaryCacheScope,
      normalizedWorkingTreePatch,
      settings.codexHomePath,
      settings.textGenerationModel,
    ],
  );
  const diffSummaryQueryOptions = useMemo(
    () =>
      gitSummarizeDiffQueryOptions({
        cwd: activeCwd ?? null,
        cacheScope: diffSummaryCacheScope,
        patch: normalizedWorkingTreePatch,
        codexHomePath: settings.codexHomePath || null,
        model: settings.textGenerationModel ?? null,
        enabled: surfaceMode === "summary",
      }),
    [
      activeCwd,
      diffSummaryCacheScope,
      normalizedWorkingTreePatch,
      settings.codexHomePath,
      settings.textGenerationModel,
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
    !diffEnvironmentPending &&
    activeCwd &&
    (!hasResolvedWorkingTreePatch || !hasNoWorkingTreeChanges),
  );
  const canPrefetchSummary = Boolean(
    diffOpen &&
    !diffEnvironmentPending &&
    activeCwd &&
    normalizedWorkingTreePatch &&
    !hasNoWorkingTreeChanges,
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
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {canScrollTurnStripRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
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
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
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
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
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
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
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
          <button
            type="button"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-foreground transition-colors hover:bg-accent [-webkit-app-region:no-drag]"
            onClick={(event) => {
              event.stopPropagation();
              onClosePanel();
            }}
          >
            <XIcon className="size-3.5" />
            <span className="sr-only">Close file view</span>
          </button>
        ) : null}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : diffEnvironmentPending ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          This chat environment is still being prepared. Diff and summary will be available once the
          worktree is ready.
        </div>
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
                  <FaPlusMinus className="size-2.25 text-black dark:text-white" />
                </span>
                <span>Review</span>
              </button>
              <button
                type="button"
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium tracking-[-0.01em] transition-colors",
                  surfaceMode === "total"
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                  !canShowTotal && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
                )}
                disabled={!canShowTotal}
                onClick={() => {
                  setSurfaceMode("total");
                }}
                aria-pressed={surfaceMode === "total"}
              >
                <DiffIcon className="size-3.5 opacity-80" />
                <span>Total</span>
              </button>
            </div>
          </div>

          {surfaceMode === "summary" ? (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-border/60 pb-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Repo summary</p>
                  <p className="text-[11px] text-muted-foreground">
                    Generated from the current total repo/worktree diff.
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

              {workingTreeDiffQuery.isLoading && !hasResolvedWorkingTreePatch ? (
                <DiffPanelLoadingState label="Loading total repo diff..." />
              ) : workingTreeDiffError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {workingTreeDiffError}
                </div>
              ) : hasNoWorkingTreeChanges ? (
                <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
                  No uncommitted repo changes in this worktree.
                </div>
              ) : diffSummaryQuery.isLoading ? (
                <DiffPanelLoadingState label="Generating repo summary..." />
              ) : diffSummaryError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {diffSummaryError}
                </div>
              ) : diffSummaryText ? (
                <ChatMarkdown
                  text={diffSummaryText}
                  cwd={activeCwd ?? undefined}
                  className="text-sm leading-7"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
                  Summary unavailable for the current total repo diff.
                </div>
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
                        ? "Loading total working tree diff..."
                        : "Loading checkpoint diff..."
                    }
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                    <p>
                      {activeReviewHasNoChanges
                        ? surfaceMode === "total"
                          ? "No uncommitted repo changes in this worktree."
                          : "No net changes in this selection."
                        : surfaceMode === "total"
                          ? "No total repo diff is available right now."
                          : "No patch available for this selection."}
                    </p>
                  </div>
                )
              ) : renderablePatch.kind === "files" ? (
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{
                    overscrollSize: 600,
                    intersectionObserverMargin: 1200,
                  }}
                >
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
                        <FileDiff
                          fileDiff={fileDiff}
                          options={{
                            diffStyle: diffRenderMode === "split" ? "split" : "unified",
                            lineDiffType: "none",
                            overflow: diffWordWrap ? "wrap" : "scroll",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: buildDiffPanelUnsafeCSS(resolvedTheme),
                            collapsed: isCollapsed,
                          }}
                          renderHeaderPrefix={() => (
                            <VscodeEntryIcon
                              pathValue={filePath}
                              kind="file"
                              theme={resolvedTheme}
                              className="size-4"
                            />
                          )}
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
                </Virtualizer>
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
