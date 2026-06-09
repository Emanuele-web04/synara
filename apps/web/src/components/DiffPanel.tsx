// FILE: DiffPanel.tsx
// Purpose: Coordinates diff-panel data sources, toolbar state, and patch body rendering.
// Layer: Diff panel container

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import { XIcon } from "~/lib/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitBranchesQueryOptions,
  gitStatusQueryOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import {
  checkpointDiffQueryOptions,
  resolveCheckpointDiffQueryDisplayState,
} from "~/lib/providerReactQuery";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffCopyText,
  sortFileDiffsByPath,
  summarizePatchTotals,
  summarizeRenderablePatchStats,
} from "../lib/diffRendering";
import { resolveDiffEnvironmentState } from "../lib/threadEnvironment";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { type RepoDiffScope, useRepoDiffScopeStore } from "../repoDiffScopeStore";
import { useStore } from "../store";
import { createProjectSelector } from "../storeSelectors";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import { useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chat/chatHeaderControls";
import {
  areAllRenderableFilesCollapsed,
  isStaleDiffTurnSelection,
  resolveConversationCacheScope,
  resolveDiffPanelGitStatusQueriesEnabled,
  resolveDiffPanelQueriesEnabled,
  resolveDiffPanelScopeCountQueriesEnabled,
  resolveDiffPanelRepoLiveRefetchIntervalMs,
  resolveDiffPanelScopeFileCounts,
  resolveDiffPanelThread,
  resolveDiffPanelViewSource,
  resolveInitialDiffViewKind,
  resolveSelectedTurnSummary,
  type DiffPanelTurnScopeIntent,
  type DiffViewKind,
} from "./DiffPanel.logic";
import { DiffPanelPatchViewport } from "./DiffPanelPatchViewport";
import { DiffPanelToolbar } from "./DiffPanelToolbar";
import {
  createDiffPanelRepoLiveRefreshSelector,
  createDiffPanelThreadCatalogSelector,
  toDiffPanelThreadCatalog,
  type DiffPanelThreadCatalog,
} from "./diffPanelSelectors";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { IconButton } from "./ui/icon-button";
import { REPO_DIFF_SCOPE_LABELS } from "../repoDiffScopeStore";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { type SplitViewPanePanelState } from "../splitViewStore";

type DiffRenderMode = "stacked" | "split";

interface DiffPanelProps {
  mode?: DiffPanelMode;
  threadId?: ThreadId | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
  /** When false, skip git/diff fetches (e.g. right dock collapsed or pane hidden). */
  queriesEnabled?: boolean;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  threadId: controlledThreadId,
  panelState,
  onUpdatePanelState,
  onClosePanel,
  liveRefreshEnabled = true,
  queriesEnabled = true,
}: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(true);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const handleScopePickerOpenChange = useCallback((open: boolean) => {
    setScopePickerOpen((previous) => (previous === open ? previous : open));
  }, []);
  const repoDiffScope = useRepoDiffScopeStore((store) => store.scope);
  const setRepoDiffScope = useRepoDiffScopeStore((store) => store.setScope);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useDiffRouteSearch();
  const diffOpen = panelState ? panelState.panel === "diff" : diffSearch.diff === "1";
  const diffQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelQueriesEnabled({
        diffOpen,
        queriesEnabled,
      }),
    [diffOpen, queriesEnabled],
  );
  const scopeCountQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelScopeCountQueriesEnabled({
        queriesEnabled: diffQueriesEnabled,
        scopePickerOpen,
      }),
    [diffQueriesEnabled, scopePickerOpen],
  );
  const activeThreadId = controlledThreadId ?? routeThreadId;
  const serverThreadCatalog = useStore(
    useMemo(() => createDiffPanelThreadCatalogSelector(activeThreadId), [activeThreadId]),
  );
  const shouldPollRepoDiff = useStore(
    useMemo(() => createDiffPanelRepoLiveRefreshSelector(activeThreadId), [activeThreadId]),
  );
  const draftThread = useComposerDraftStore((store) =>
    activeThreadId ? (store.draftThreadsByThreadId[activeThreadId] ?? null) : null,
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  // Keep draft-backed thread context available before the first server turn exists.
  const activeThreadContext = useMemo((): DiffPanelThreadCatalog | undefined => {
    if (serverThreadCatalog) {
      return serverThreadCatalog;
    }
    const draftBackedThread = resolveDiffPanelThread({
      threadId: activeThreadId,
      serverThread: undefined,
      draftThread,
      fallbackModelSelection: fallbackDraftProject?.defaultModelSelection ?? null,
    });
    return draftBackedThread ? toDiffPanelThreadCatalog(draftBackedThread) : undefined;
  }, [
    activeThreadId,
    draftThread,
    fallbackDraftProject?.defaultModelSelection,
    serverThreadCatalog,
  ]);
  const activeProjectId = activeThreadContext?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const resolvedThreadEnvMode =
    serverThreadCatalog?.envMode ?? draftThread?.envMode ?? activeThreadContext?.envMode;
  const resolvedThreadWorktreePath =
    serverThreadCatalog?.worktreePath ??
    draftThread?.worktreePath ??
    activeThreadContext?.worktreePath ??
    null;
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const activeCwd = diffEnvironmentState.cwd;
  const selectedTurnId = panelState
    ? (panelState.diffTurnId ?? null)
    : (diffSearch.diffTurnId ?? null);
  const [diffViewKind, setDiffViewKind] = useState<DiffViewKind>(() =>
    resolveInitialDiffViewKind(selectedTurnId),
  );
  const [turnScopeIntent, setTurnScopeIntent] = useState<DiffPanelTurnScopeIntent>(() =>
    selectedTurnId === null ? "all" : "last",
  );
  const gitStatusQueriesEnabled = useMemo(
    () =>
      resolveDiffPanelGitStatusQueriesEnabled({
        queriesEnabled: diffQueriesEnabled,
        activeCwd,
        diffViewKind,
      }),
    [activeCwd, diffQueriesEnabled, diffViewKind],
  );
  const gitBranchesQuery = useQuery({
    ...gitBranchesQueryOptions(activeCwd ?? null),
    enabled: diffQueriesEnabled && activeCwd !== null,
  });
  const gitStatusQuery = useQuery({
    ...gitStatusQueryOptions(activeCwd ?? null),
    enabled: gitStatusQueriesEnabled,
  });
  const gitRepoStatus = gitBranchesQuery.isSuccess ? gitBranchesQuery.data.isRepo : undefined;
  const isGitRepo = gitRepoStatus === true;
  const turnDiffSummaries = activeThreadContext?.turnDiffSummaries ?? [];
  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );
  const repoDiffLiveRefreshIntervalMs = useMemo(
    () =>
      resolveDiffPanelRepoLiveRefetchIntervalMs({
        queriesEnabled: diffQueriesEnabled,
        liveRefreshEnabled,
        diffViewKind,
        shouldPollRepoDiff,
      }),
    [diffQueriesEnabled, diffViewKind, liveRefreshEnabled, shouldPollRepoDiff],
  );
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

  const selectedFilePath = panelState
    ? (panelState.diffFilePath ?? null)
    : (diffSearch.diffFilePath ?? null);
  const selectedTurn = useMemo(
    () => resolveSelectedTurnSummary(selectedTurnId, orderedTurnDiffSummaries),
    [orderedTurnDiffSummaries, selectedTurnId],
  );
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
      !selectedTurn &&
      turnScopeIntent !== "last" &&
      typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn, turnScopeIntent],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(
    () =>
      selectedTurn || orderedTurnDiffSummaries.length === 0
        ? null
        : resolveConversationCacheScope(conversationCheckpointTurnCount),
    [conversationCheckpointTurnCount, orderedTurnDiffSummaries.length, selectedTurn],
  );
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled:
        diffQueriesEnabled && isGitRepo && !diffEnvironmentPending && diffViewKind === "turn",
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const checkpointDiffDisplay = resolveCheckpointDiffQueryDisplayState({
    isLoading: activeCheckpointDiffQuery.isLoading,
    isFetching: activeCheckpointDiffQuery.isFetching,
    data: activeCheckpointDiffQuery.data,
    error: activeCheckpointDiffQuery.error,
  });
  const isLoadingCheckpointDiff = checkpointDiffDisplay.isLoading;
  const checkpointDiffError = checkpointDiffDisplay.error;

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const unstagedDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "unstaged",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const stagedDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "staged",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const branchDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "branch",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const repoDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: repoDiffScope,
      enabled: diffQueriesEnabled && !diffEnvironmentPending && diffViewKind === "repo",
      refetchInterval: repoDiffLiveRefreshIntervalMs,
    }),
  );
  const repoPatch = repoDiffQuery.data?.patch;
  const hasResolvedRepoPatch = typeof repoPatch === "string";
  const hasNoRepoChanges = hasResolvedRepoPatch && repoPatch.trim().length === 0;
  const repoDiffError =
    repoDiffQuery.error instanceof Error
      ? repoDiffQuery.error.message
      : repoDiffQuery.error
        ? "Failed to load repo diff."
        : null;
  const branchHasCommittedChanges = (gitStatusQuery.data?.aheadCount ?? 0) > 0;

  useEffect(() => {
    if (
      diffOpen &&
      diffViewKind === "repo" &&
      repoDiffScope === "workingTree" &&
      hasResolvedRepoPatch &&
      hasNoRepoChanges &&
      branchHasCommittedChanges
    ) {
      setRepoDiffScope("branch");
    }
  }, [
    branchHasCommittedChanges,
    diffOpen,
    diffViewKind,
    hasNoRepoChanges,
    hasResolvedRepoPatch,
    repoDiffScope,
    setRepoDiffScope,
  ]);

  const viewSource = useMemo(
    () =>
      resolveDiffPanelViewSource({
        diffViewKind,
        repoDiffScope,
        selectedTurnId,
      }),
    [diffViewKind, repoDiffScope, selectedTurnId],
  );
  const activeReviewPatch = diffViewKind === "repo" ? repoPatch : selectedPatch;
  const activeReviewError = diffViewKind === "repo" ? repoDiffError : checkpointDiffError;
  const activeReviewIsLoading =
    diffViewKind === "repo" ? repoDiffQuery.isLoading : isLoadingCheckpointDiff;
  const activeReviewHasNoChanges = diffViewKind === "repo" ? hasNoRepoChanges : hasNoNetChanges;
  const { copyToClipboard: copyDiffToClipboard, isCopied: isDiffCopied } = useCopyToClipboard();
  const diffCopyText = useMemo(() => resolveDiffCopyText(activeReviewPatch), [activeReviewPatch]);
  // The parsed patch is structural and theme-agnostic — theming is applied
  // separately via the themed row key and buildDiffPanelUnsafeCSS (cached per
  // theme). Keeping `resolvedTheme` out of the parse cache scope and these deps
  // avoids re-parsing the whole patch on every light/dark toggle.
  const renderablePatch = useMemo(() => getRenderablePatch(activeReviewPatch), [activeReviewPatch]);
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return sortFileDiffsByPath(renderablePatch.files);
  }, [renderablePatch]);
  const activePatchStat = useMemo(
    () => summarizeRenderablePatchStats(renderablePatch),
    [renderablePatch],
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      cwd: activeCwd ?? null,
      scope: "workingTree",
      enabled: scopeCountQueriesEnabled && !diffEnvironmentPending,
    }),
  );
  const pickerScopeFileCounts = useMemo(() => {
    const counts: Partial<Record<RepoDiffScope, number>> = {};
    const workingTreeCount = summarizePatchTotals(workingTreeDiffQuery.data?.patch)?.fileCount;
    const unstagedCount = summarizePatchTotals(unstagedDiffQuery.data?.patch)?.fileCount;
    const stagedCount = summarizePatchTotals(stagedDiffQuery.data?.patch)?.fileCount;
    const branchCount = summarizePatchTotals(branchDiffQuery.data?.patch)?.fileCount;
    if (typeof workingTreeCount === "number") counts.workingTree = workingTreeCount;
    if (typeof unstagedCount === "number") counts.unstaged = unstagedCount;
    if (typeof stagedCount === "number") counts.staged = stagedCount;
    if (typeof branchCount === "number") counts.branch = branchCount;
    return counts;
  }, [
    branchDiffQuery.data?.patch,
    stagedDiffQuery.data?.patch,
    unstagedDiffQuery.data?.patch,
    workingTreeDiffQuery.data?.patch,
  ]);
  const scopeFileCounts = useMemo(
    () =>
      resolveDiffPanelScopeFileCounts({
        viewSource,
        activeScopeFileCount: activePatchStat?.fileCount,
        scopePickerOpen,
        pickerScopeCounts: pickerScopeFileCounts,
      }),
    [activePatchStat?.fileCount, pickerScopeFileCounts, scopePickerOpen, viewSource],
  );
  const allFilesCollapsed = useMemo(
    () => areAllRenderableFilesCollapsed(renderableFiles, collapsedFiles),
    [collapsedFiles, renderableFiles],
  );
  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffViewKind(resolveInitialDiffViewKind(selectedTurnId));
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, selectedTurnId, settings.diffWordWrap]);

  useEffect(() => {
    if (selectedTurnId !== null) {
      setDiffViewKind((current) => (current === "turn" ? current : "turn"));
    }
  }, [selectedTurnId]);

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

  const updateDiffSelection = useCallback(
    (input: { turnId: TurnId | null; filePath?: string | null }) => {
      if (!activeThreadContext) return;
      if (onUpdatePanelState) {
        onUpdatePanelState({
          panel: "diff",
          diffTurnId: input.turnId,
          diffFilePath: input.filePath ?? null,
        });
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: activeThreadContext.id },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return {
            ...rest,
            panel: "diff",
            diff: "1",
            ...(input.turnId ? { diffTurnId: input.turnId } : {}),
            ...(input.filePath ? { diffFilePath: input.filePath } : {}),
          };
        },
      });
    },
    [activeThreadContext, navigate, onUpdatePanelState],
  );
  useEffect(() => {
    if (!diffOpen || !activeThreadContext) {
      return;
    }
    if (!isStaleDiffTurnSelection(selectedTurnId, orderedTurnDiffSummaries)) {
      return;
    }
    updateDiffSelection({ turnId: null, filePath: null });
  }, [
    activeThreadContext,
    diffOpen,
    orderedTurnDiffSummaries,
    selectedTurnId,
    updateDiffSelection,
  ]);
  const selectTurn = useCallback(
    (turnId: TurnId | null) => {
      setDiffViewKind("turn");
      setTurnScopeIntent(turnId === null ? "all" : "last");
      updateDiffSelection({ turnId, filePath: null });
    },
    [updateDiffSelection],
  );
  const selectRepoScope = useCallback(
    (scope: typeof repoDiffScope) => {
      setDiffViewKind("repo");
      setRepoDiffScope(scope);
      if (selectedTurnId !== null) {
        updateDiffSelection({ turnId: null, filePath: null });
      }
    },
    [selectedTurnId, setRepoDiffScope, updateDiffSelection],
  );
  const selectAllTurns = useCallback(() => {
    setTurnScopeIntent("all");
    selectTurn(null);
  }, [selectTurn]);
  const selectLastTurn = useCallback(() => {
    const latestTurn = orderedTurnDiffSummaries[0];
    setTurnScopeIntent("last");
    setDiffViewKind("turn");
    if (!latestTurn) {
      if (selectedTurnId !== null) {
        updateDiffSelection({ turnId: null, filePath: null });
      }
      return;
    }
    selectTurn(latestTurn.turnId);
  }, [orderedTurnDiffSummaries, selectTurn, selectedTurnId, updateDiffSelection]);
  const toggleCollapseAll = useCallback(() => {
    setCollapsedFiles((previous) => {
      if (areAllRenderableFilesCollapsed(renderableFiles, previous)) {
        return new Set();
      }
      return new Set(renderableFiles.map((fileDiff) => buildFileDiffRenderKey(fileDiff)));
    });
  }, [renderableFiles]);
  const selectFile = useCallback(
    (filePath: string) => {
      updateDiffSelection({ turnId: selectedTurnId, filePath });
    },
    [selectedTurnId, updateDiffSelection],
  );
  const showDiffToolbar = Boolean(activeThreadContext && isGitRepo && !diffEnvironmentPending);
  const copyDiff = useCallback(() => {
    if (diffCopyText) {
      copyDiffToClipboard(diffCopyText, undefined);
    }
  }, [copyDiffToClipboard, diffCopyText]);

  const shellHeader = useMemo(
    () =>
      showDiffToolbar ? (
        <DiffPanelToolbar
          activeCwd={activeCwd}
          activeThreadId={activeThreadId}
          viewSource={viewSource}
          turnScopeIntent={turnScopeIntent}
          scopeFileCounts={scopeFileCounts}
          activeStats={
            activePatchStat
              ? {
                  additions: activePatchStat.additions,
                  deletions: activePatchStat.deletions,
                }
              : null
          }
          orderedTurnDiffSummaries={orderedTurnDiffSummaries}
          inferredCheckpointTurnCountByTurnId={inferredCheckpointTurnCountByTurnId}
          selectedTurnId={selectedTurnId}
          timestampFormat={settings.timestampFormat}
          renderableFiles={renderableFiles}
          selectedFilePath={selectedFilePath}
          resolvedTheme={resolvedTheme}
          diffRenderMode={diffRenderMode}
          diffWordWrap={diffWordWrap}
          diffIgnoreWhitespace={diffIgnoreWhitespace}
          diffCopyText={diffCopyText}
          isDiffCopied={isDiffCopied}
          allFilesCollapsed={allFilesCollapsed}
          onSelectRepoScope={selectRepoScope}
          onSelectAllTurns={selectAllTurns}
          onSelectLastTurn={selectLastTurn}
          onSelectTurn={selectTurn}
          onSelectFile={selectFile}
          onDiffRenderModeChange={setDiffRenderMode}
          onDiffWordWrapChange={setDiffWordWrap}
          onDiffIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
          onCopyDiff={copyDiff}
          onToggleCollapseAll={toggleCollapseAll}
          scopePickerOpen={scopePickerOpen}
          onScopePickerOpenChange={handleScopePickerOpenChange}
          {...(onClosePanel ? { onClosePanel } : {})}
        />
      ) : onClosePanel ? (
        <div className="flex h-full w-full items-center justify-end px-3 [-webkit-app-region:no-drag]">
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="Close file view"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={(event) => {
              event.stopPropagation();
              onClosePanel();
            }}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null,
    [
      activeCwd,
      activePatchStat,
      activeThreadId,
      allFilesCollapsed,
      copyDiff,
      diffCopyText,
      diffIgnoreWhitespace,
      diffRenderMode,
      diffWordWrap,
      inferredCheckpointTurnCountByTurnId,
      isDiffCopied,
      handleScopePickerOpenChange,
      onClosePanel,
      orderedTurnDiffSummaries,
      scopePickerOpen,
      renderableFiles,
      resolvedTheme,
      scopeFileCounts,
      selectAllTurns,
      selectFile,
      selectLastTurn,
      selectRepoScope,
      selectTurn,
      selectedFilePath,
      selectedTurnId,
      settings.timestampFormat,
      showDiffToolbar,
      toggleCollapseAll,
      turnScopeIntent,
      viewSource,
    ],
  );

  return (
    <DiffPanelShell mode={mode} header={shellHeader}>
      {!activeThreadContext ? (
        <PanelStateMessage density="compact" fill="flex">
          Select a thread to inspect turn diffs.
        </PanelStateMessage>
      ) : gitRepoStatus === false ? (
        <PanelStateMessage density="compact" fill="flex">
          Turn diffs are unavailable because this project is not a git repository.
        </PanelStateMessage>
      ) : gitRepoStatus === undefined && diffQueriesEnabled && activeCwd ? (
        <DiffPanelLoadingState label="Checking git repository..." />
      ) : diffEnvironmentPending ? (
        <PanelStateMessage density="compact" fill="flex">
          This chat environment is still being prepared. Diffs will be available once the worktree
          is ready.
        </PanelStateMessage>
      ) : (
        <div
          ref={patchViewportRef}
          className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          <DiffPanelPatchViewport
            renderablePatch={renderablePatch}
            renderableFiles={renderableFiles}
            resolvedTheme={resolvedTheme}
            diffRenderMode={diffRenderMode}
            diffWordWrap={diffWordWrap}
            collapsedFiles={collapsedFiles}
            onToggleFileCollapsed={toggleFileCollapsed}
            isLoading={activeReviewIsLoading}
            hasNoChanges={activeReviewHasNoChanges}
            error={activeReviewError}
            viewKind={diffViewKind}
            loadingLabel={
              diffViewKind === "repo"
                ? `Loading ${REPO_DIFF_SCOPE_LABELS[repoDiffScope].toLowerCase()} diff...`
                : "Loading checkpoint diff..."
            }
            emptyLabel={
              diffViewKind === "repo"
                ? "No changes in the selected diff source."
                : orderedTurnDiffSummaries.length === 0
                  ? "No turn diffs are available yet."
                  : "No net changes in this selection."
            }
            unavailableLabel="No repo diff is available right now."
          />
        </div>
      )}
    </DiffPanelShell>
  );
}
