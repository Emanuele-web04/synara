import type { DiffLineAnnotation } from "@pierre/diffs";
import type {
  ReviewChangedFile,
  ReviewFinding,
  ReviewLocalComment,
  ReviewRemoteThread,
  ReviewTargetKey,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffPath,
  sortFileDiffsByPath,
} from "~/lib/diffRendering";
import {
  Columns2Icon,
  EllipsisIcon,
  Rows3Icon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import {
  reviewAddCommentMutationOptions,
  reviewListCommentsQueryOptions,
  reviewLoadRemoteThreadsQueryOptions,
  reviewViewerQueryOptions,
  reviewRemoveCommentMutationOptions,
  reviewUpdateCommentMutationOptions,
} from "~/lib/reviewReactQuery";
import { cn } from "~/lib/utils";
import { selectReviewAgentFindings, selectReviewDrafts, useReviewStore } from "~/reviewStore";
import { type ReviewDraftComment, reviewTargetKeyString } from "~/reviewStore.logic";
import { useTheme } from "../../hooks/useTheme";
import { DiffStat } from "../chat/DiffStatLabel";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ReviewFileDiffBlock } from "./ReviewFileDiffBlock";
import { ReviewCommentThread, type ReviewCommentThreadActions } from "./ReviewCommentThread";
import {
  annotationAnchorKey,
  type ReviewLineAnnotationData,
  toAnnotationSide,
} from "./reviewAnnotations";

type DiffRenderMode = "stacked" | "split";

type FileAnnotationMap = Map<string, DiffLineAnnotation<ReviewLineAnnotationData>[]>;

const EMPTY_ANNOTATIONS: DiffLineAnnotation<ReviewLineAnnotationData>[] = [];
const INITIAL_HYDRATED_FILE_COUNT = 4;
const HYDRATION_BATCH_SIZE = 8;
const HYDRATION_IDLE_TIMEOUT_MS = 80;
type IdleCallbackHandle = ReturnType<typeof requestIdleCallback>;

export function ReviewDiffPane(props: {
  patch: string | undefined;
  target: ReviewTargetKey | null;
  isLoading: boolean;
  error?: string | null;
  selectedFilePath?: string | null;
  density?: "page" | "dock";
  cwd?: string | null;
  reference?: string | null;
  patchSignature?: string | null;
  headSha?: string | null;
  summary?: { files: number; additions: number; deletions: number } | null;
  viewedSummary?: { viewed: number; total: number } | null;
  viewedPaths?: ReadonlySet<string>;
  files?: ReadonlyArray<ReviewChangedFile>;
  onSelectFile?: (path: string | null) => void;
  onToggleViewed?: (path: string) => void;
  reviewAction?: ReactNode;
  navigationAction?: ReactNode;
  agentControl?: ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(false);
  // Collapse is `override ?? viewed`: viewed files fold by default, unviewed stay
  // open, and an explicit header click records an override that wins either way.
  const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(() => new Map());
  const viewedPaths = props.viewedPaths;
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const density = props.density ?? "page";

  const target = props.target;
  const targetKey = target ? reviewTargetKeyString(target) : null;

  const commentsQuery = useQuery(reviewListCommentsQueryOptions({ target }));
  const viewerQuery = useQuery(reviewViewerQueryOptions({ cwd: props.cwd ?? null }));
  const viewerIdentity = viewerQuery.data
    ? `${viewerQuery.data.login}:${viewerQuery.data.avatarUrl ?? ""}`
    : "viewer-pending";
  const remoteThreadsEnabled = target?._tag === "pullRequest";
  const remoteThreadsQuery = useQuery(
    reviewLoadRemoteThreadsQueryOptions({
      cwd: remoteThreadsEnabled ? (props.cwd ?? null) : null,
      reference: remoteThreadsEnabled ? (props.reference ?? null) : null,
    }),
  );
  const drafts = useReviewStore(selectReviewDrafts(targetKey ?? "none"));
  const agentFindings = useReviewStore(
    selectReviewAgentFindings(target, props.patchSignature ?? null, props.headSha ?? null),
  );
  const beginDraft = useReviewStore((store) => store.beginDraft);
  const editDraft = useReviewStore((store) => store.editDraft);
  const discardDraft = useReviewStore((store) => store.discardDraft);
  const reconcile = useReviewStore((store) => store.reconcile);
  const dismissFinding = useReviewStore((store) => store.dismissFinding);

  const addCommentMutation = useMutation(reviewAddCommentMutationOptions({ queryClient }));
  const updateCommentMutation = useMutation(reviewUpdateCommentMutationOptions({ queryClient }));
  const removeCommentMutation = useMutation(reviewRemoveCommentMutationOptions({ queryClient }));

  const serverComments = commentsQuery.data?.comments;
  const remoteThreads = remoteThreadsQuery.data?.threads;

  useEffect(() => {
    if (target && serverComments) {
      reconcile(target, serverComments);
    }
  }, [target, serverComments, reconcile]);

  const renderablePatch = useMemo(
    () => getRenderablePatch(props.patch, `review:${resolvedTheme}`),
    [props.patch, resolvedTheme],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return sortFileDiffsByPath(renderablePatch.files);
  }, [renderablePatch]);
  const renderableFileSignature = useMemo(
    () => renderableFiles.map((fileDiff) => buildFileDiffRenderKey(fileDiff)).join("\n"),
    [renderableFiles],
  );
  const [hydratedFileCount, setHydratedFileCount] = useState(INITIAL_HYDRATED_FILE_COUNT);

  useEffect(() => {
    setHydratedFileCount(INITIAL_HYDRATED_FILE_COUNT);
  }, [renderableFileSignature]);

  useEffect(() => {
    if (hydratedFileCount >= renderableFiles.length) {
      return;
    }

    const hydrateNextBatch = () => {
      setHydratedFileCount((count) =>
        Math.min(renderableFiles.length, count + HYDRATION_BATCH_SIZE),
      );
    };

    if (typeof requestIdleCallback === "function") {
      const idleId: IdleCallbackHandle = requestIdleCallback(hydrateNextBatch, {
        timeout: HYDRATION_IDLE_TIMEOUT_MS,
      });
      return () => cancelIdleCallback(idleId);
    }

    const timeoutId = setTimeout(hydrateNextBatch, HYDRATION_IDLE_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, [hydratedFileCount, renderableFiles.length]);

  const annotationsByFile = useMemo(
    () => buildAnnotationsByFile(serverComments ?? [], drafts, remoteThreads ?? [], agentFindings),
    [serverComments, drafts, remoteThreads, agentFindings],
  );

  useEffect(() => {
    if (!props.selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const scrollTarget = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === props.selectedFilePath);
    scrollTarget?.scrollIntoView({ block: "start" });
  }, [props.selectedFilePath, renderableFiles]);

  const isFileCollapsed = useCallback(
    (fileKey: string, filePath: string) =>
      collapseOverrides.get(fileKey) ?? viewedPaths?.has(filePath) ?? false,
    [collapseOverrides, viewedPaths],
  );

  const toggleFileCollapsed = useCallback(
    (fileKey: string, filePath: string) => {
      setCollapseOverrides((prev) => {
        const next = new Map(prev);
        next.set(fileKey, !isFileCollapsed(fileKey, filePath));
        return next;
      });
    },
    [isFileCollapsed],
  );

  const handleStartDraft = useCallback(
    (anchor: { path: string; line: number; side: ReviewLocalComment["side"] }) => {
      if (!target) return;
      beginDraft({ target, path: anchor.path, line: anchor.line, side: anchor.side });
    },
    [target, beginDraft],
  );

  const threadActions = useMemo<ReviewCommentThreadActions>(
    () => ({
      saveDraft: (draftId, body) => {
        if (!target) return;
        const draft = drafts.find((entry) => entry.draftId === draftId);
        if (!draft) return;
        editDraft(target, draftId, { body, status: "saving" });
        addCommentMutation.mutate(
          {
            target,
            path: draft.path,
            line: draft.line,
            side: draft.side,
            body,
            ...(draft.threadId ? { threadId: draft.threadId } : {}),
          },
          {
            onSuccess: () => discardDraft(target, draftId),
            onError: () => editDraft(target, draftId, { status: "editing" }),
          },
        );
      },
      cancelDraft: (draftId) => {
        if (target) discardDraft(target, draftId);
      },
      updateBody: (comment, body) => {
        if (target) updateCommentMutation.mutate({ target, id: comment.id, body });
      },
      toggleResolved: (comment) => {
        if (target) {
          updateCommentMutation.mutate({ target, id: comment.id, resolved: !comment.resolved });
        }
      },
      remove: (comment) => {
        if (target) removeCommentMutation.mutate({ target, id: comment.id });
      },
      startReply: (data) => {
        if (!target) return;
        const threadId = data.comments.at(0)?.threadId ?? null;
        beginDraft({ target, path: data.path, line: data.line, side: data.side, threadId });
      },
      convertFinding: (finding) => {
        if (!target) return;
        if (
          findingAlreadyCommented({
            finding,
            comments: serverComments ?? [],
            drafts,
            remoteThreads: remoteThreads ?? [],
          })
        ) {
          dismissFinding(target, finding);
          return;
        }
        addCommentMutation.mutate(
          {
            target,
            path: finding.path,
            line: finding.line,
            side: finding.side,
            body: formatFindingBody(finding),
          },
          { onSuccess: () => dismissFinding(target, finding) },
        );
      },
      dismissFinding: (finding) => {
        if (target) dismissFinding(target, finding);
      },
    }),
    [
      target,
      drafts,
      serverComments,
      remoteThreads,
      editDraft,
      discardDraft,
      beginDraft,
      addCommentMutation,
      updateCommentMutation,
      removeCommentMutation,
      dismissFinding,
    ],
  );

  const renderAnnotation = useCallback(
    (data: ReviewLineAnnotationData) => (
      <ReviewCommentThread data={data} actions={threadActions} viewer={viewerQuery.data ?? null} />
    ),
    [threadActions, viewerQuery.data],
  );

  const commentsEnabled = target !== null;
  const selectedFilePath = props.selectedFilePath ?? null;
  const fileOptions = props.files ?? [];
  const onSelectFile = props.onSelectFile;
  const selectedFileLabel = selectedFilePath ?? "All files";
  const layoutControls = (
    <ToggleGroup
      className={cn(
        "shrink-0",
        density === "page"
          ? "gap-0.5 rounded-lg bg-transparent p-0"
          : "rounded-lg bg-muted/24 p-0.5 ring-1 ring-border/55",
      )}
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
      <Toggle
        aria-label="Stacked diff view"
        value="stacked"
        className={density === "page" ? "size-7 rounded-lg border-0 bg-transparent px-0" : ""}
      >
        <Rows3Icon className="size-3.5" />
      </Toggle>
      <Toggle
        aria-label="Split diff view"
        value="split"
        className={density === "page" ? "size-7 rounded-lg border-0 bg-transparent px-0" : ""}
      >
        <Columns2Icon className="size-3.5" />
      </Toggle>
    </ToggleGroup>
  );
  const wrapControl = (
    <Toggle
      aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
      title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
      variant="outline"
      size="xs"
      className={cn(
        "bg-transparent",
        density === "page"
          ? "size-7 justify-center rounded-lg border-0 px-0"
          : "justify-start rounded-lg",
      )}
      pressed={diffWordWrap}
      onPressedChange={(pressed) => setDiffWordWrap(Boolean(pressed))}
    >
      <TextWrapIcon className="size-3.5" />
      {density === "page" ? <span className="sr-only">Wrap lines</span> : "Wrap lines"}
    </Toggle>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "group/diff-strip shrink-0 overflow-hidden border-b border-border/35 bg-background",
          density === "page" ? "flex flex-col" : "flex h-8 items-center gap-2 px-3",
        )}
      >
        {density === "page" && props.agentControl ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/30 px-3">
            {props.agentControl}
          </div>
        ) : null}
        <div className={cn(density === "page" ? "flex h-9 items-center gap-2 px-3" : "contents")}>
          {props.summary && props.summary.files > 0 ? (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 overflow-hidden",
                density === "page" && "gap-2.5",
              )}
            >
              {density === "page" ? (
                <>
                  <div className="flex min-w-0 shrink-0 items-center gap-2">
                    <span className="font-semibold text-[12px] text-foreground/95">
                      Changed files
                    </span>
                    <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums sm:inline-flex">
                      <span>
                        {props.summary.files} file{props.summary.files === 1 ? "" : "s"}
                      </span>
                      <DiffStat
                        additions={props.summary.additions}
                        deletions={props.summary.deletions}
                        className="text-[11px]"
                      />
                    </span>
                  </div>
                  {fileOptions.length > 0 && onSelectFile ? (
                    <select
                      aria-label="Jump to changed file"
                      value={selectedFilePath ?? ""}
                      title={selectedFileLabel}
                      onChange={(event) => onSelectFile(event.currentTarget.value || null)}
                      className={cn(
                        "h-7 min-w-0 flex-1 truncate rounded-lg border border-border/35 bg-muted/25 px-2.5 font-mono text-[11px] text-foreground outline-none",
                        "transition-[background-color,border-color,color,box-shadow] duration-150 hover:bg-card/55 focus-visible:border-border/75 focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <option value="">All files</option>
                      {fileOptions.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.path}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate rounded-lg border border-border/30 bg-muted/20 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                      title={selectedFileLabel}
                    >
                      {selectedFileLabel}
                    </span>
                  )}
                  <div className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border/30 bg-muted/20 p-0.5">
                    {layoutControls}
                    <span className="h-4 w-px bg-border/45" aria-hidden="true" />
                    {wrapControl}
                  </div>
                  {props.reviewAction || props.navigationAction ? (
                    <div className="ms-auto flex shrink-0 items-center gap-1.5">
                      {props.reviewAction}
                      {props.navigationAction}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="flex min-w-0 flex-col">
                    <span
                      className="min-w-0 max-w-[42rem] truncate font-semibold text-[13px] leading-4 text-foreground"
                      title="Files"
                    >
                      Files
                    </span>
                  </div>
                  <span className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums sm:flex">
                    <span>
                      <span className="font-medium text-foreground">{props.summary.files}</span>{" "}
                      file
                      {props.summary.files === 1 ? "" : "s"}
                    </span>
                    <DiffStat
                      additions={props.summary.additions}
                      deletions={props.summary.deletions}
                    />
                  </span>
                  {fileOptions.length > 0 && onSelectFile ? (
                    <select
                      aria-label="Jump to changed file"
                      value={selectedFilePath ?? ""}
                      onChange={(event) => onSelectFile(event.currentTarget.value || null)}
                      className={cn(
                        "min-h-7 min-w-0 flex-1 truncate rounded-lg border border-border/45 bg-card/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground outline-none transition-colors hover:bg-card/55 hover:text-foreground focus-visible:border-border/80 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        "max-w-72",
                      )}
                    >
                      <option value="">All files</option>
                      {fileOptions.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.path}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </>
              )}
            </div>
          ) : props.isLoading ? (
            <div className="flex min-w-0 flex-1 items-center gap-2" aria-busy="true">
              <span className="font-medium text-[12px] text-foreground">
                {density === "page" ? "Changed files" : "Files"}
              </span>
              <span className="text-[11px] text-muted-foreground">Loading changed files</span>
              <span className="hidden h-5 w-48 animate-pulse rounded-lg bg-muted/35 sm:block" />
            </div>
          ) : null}
          {density !== "page" && props.agentControl ? (
            <div className="ms-auto hidden min-w-0 shrink-0 items-center lg:flex">
              {props.agentControl}
            </div>
          ) : null}
          {density === "dock" ? (
            <Popover>
              <PopoverTrigger
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/65 opacity-70 outline-none transition-[background-color,color,opacity] hover:bg-card/55 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/diff-strip:opacity-100",
                  !props.agentControl && "ms-auto",
                )}
                aria-label="Diff view options"
                title="Diff view options"
              >
                <EllipsisIcon className="size-3.5" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverPopup align="end" side="bottom" sideOffset={6} className="w-44">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-muted-foreground">Layout</span>
                    {layoutControls}
                  </div>
                  {wrapControl}
                </div>
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>

      <div
        ref={patchViewportRef}
        className="review-diff-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
      >
        {props.error && !renderablePatch ? (
          <div className="px-3 pt-2.5">
            <p className="flex items-center gap-1.5 text-[11px] text-destructive">
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              <span className="min-w-0">{props.error}</span>
            </p>
          </div>
        ) : null}
        {!renderablePatch ? (
          props.isLoading ? (
            <DiffPaneLoadingState density={density} />
          ) : (
            <PanelStateMessage density="compact" fill="flex">
              No changes to review in this changeset.
            </PanelStateMessage>
          )
        ) : renderablePatch.kind === "files" ? (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-visible",
              density === "page" ? "min-h-full px-0 py-0" : "px-1",
            )}
          >
            <div className="shrink-0">
              {renderableFiles.map((fileDiff, index) => {
                const filePath = resolveFileDiffPath(fileDiff);
                const fileKey = buildFileDiffRenderKey(fileDiff);
                const themedFileKey = `${fileKey}:${resolvedTheme}:${viewerIdentity}`;
                const isCollapsed = isFileCollapsed(fileKey, filePath);
                const fileAnnotations = commentsEnabled
                  ? (annotationsByFile.get(filePath) ?? EMPTY_ANNOTATIONS)
                  : EMPTY_ANNOTATIONS;
                const shouldHydrate =
                  index < hydratedFileCount || props.selectedFilePath === filePath;
                const toggleViewedForFile = props.onToggleViewed;
                const onToggleReviewed = toggleViewedForFile
                  ? () => toggleViewedForFile(filePath)
                  : undefined;
                return (
                  <div
                    key={themedFileKey}
                    data-diff-file-path={filePath}
                    className={cn(
                      density === "page"
                        ? "diff-render-file scroll-mt-12"
                        : "diff-render-file mb-3 scroll-mt-16 last:mb-0",
                      selectedFilePath === filePath && "outline outline-1 outline-primary/30",
                    )}
                    onClickCapture={(event) => {
                      const nativeEvent = event.nativeEvent as MouseEvent;
                      const composedPath = nativeEvent.composedPath?.() ?? [];
                      const clickedInteractive = composedPath.some((node) => {
                        if (!(node instanceof Element)) return false;
                        return Boolean(
                          node.closest(
                            'button,a,input,textarea,select,[role="button"],[contenteditable="true"]',
                          ),
                        );
                      });
                      if (clickedInteractive) return;
                      const clickedHeader = composedPath.some((node) => {
                        if (!(node instanceof Element)) return false;
                        return (
                          node.hasAttribute("data-diffs-header") ||
                          node.hasAttribute("data-file-info")
                        );
                      });
                      if (!clickedHeader) return;
                      event.stopPropagation();
                      toggleFileCollapsed(fileKey, filePath);
                    }}
                  >
                    {shouldHydrate ? (
                      <ReviewFileDiffBlock
                        fileDiff={fileDiff}
                        theme={resolvedTheme}
                        diffStyle={diffRenderMode === "split" ? "split" : "unified"}
                        overflow={diffWordWrap ? "wrap" : "scroll"}
                        collapsed={isCollapsed}
                        reviewed={viewedPaths?.has(filePath) ?? false}
                        lineAnnotations={fileAnnotations}
                        {...(onToggleReviewed ? { onToggleReviewed } : {})}
                        onStartDraft={handleStartDraft}
                        renderAnnotation={renderAnnotation}
                      />
                    ) : (
                      <DiffFilePlaceholder filePath={filePath} />
                    )}
                  </div>
                );
              })}
            </div>
            <div aria-hidden="true" className="h-3 shrink-0" />
          </div>
        ) : (
          <div className="h-full min-w-0 overflow-auto p-2">
            <div className="flex min-w-0 flex-col gap-2">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                {renderablePatch.reason}
              </p>
              <pre
                className={cn(
                  "min-w-0 max-w-full rounded-xl border border-border/70 bg-muted/20 p-3 font-mono text-[11px] leading-relaxed text-foreground/90",
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
    </div>
  );
}

function DiffPaneLoadingState(props: { density: "page" | "dock" }) {
  const fileCount = props.density === "page" ? 5 : 3;
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden",
        props.density === "page" ? "px-3 py-3" : "px-1.5 py-2",
      )}
      aria-busy="true"
      aria-label="Loading diff"
    >
      {Array.from({ length: fileCount }, (_, fileIndex) => (
        <section
          key={fileIndex}
          className="shrink-0 overflow-hidden rounded-xl border border-border/55 bg-card/45"
        >
          <div className="flex h-9 items-center gap-2 border-b border-border/40 bg-muted/25 px-3">
            <span className="size-3.5 shrink-0 animate-pulse rounded bg-muted/60" />
            <span className="h-3 w-[min(18rem,55%)] animate-pulse rounded bg-muted/55" />
            <span className="ms-auto h-3 w-10 animate-pulse rounded bg-success/20" />
          </div>
          <div className="flex flex-col gap-1.5 px-3 py-3 font-mono text-[11px]">
            {Array.from({ length: fileIndex === 0 ? 7 : 4 }, (_, lineIndex) => (
              <div key={lineIndex} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3">
                <span className="h-3 animate-pulse rounded bg-muted/35" />
                <span
                  className={cn(
                    "h-3 animate-pulse rounded bg-muted/35",
                    lineIndex % 3 === 0 && "w-11/12",
                    lineIndex % 3 === 1 && "w-8/12",
                    lineIndex % 3 === 2 && "w-10/12",
                  )}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DiffFilePlaceholder(props: { filePath: string }) {
  return (
    <div className="overflow-hidden border-b border-border/45 bg-muted/18">
      <div className="flex h-8 items-center gap-2 border-b border-border/55 bg-muted/30 px-3">
        <span className="size-3.5 shrink-0 rounded-md bg-muted" />
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {props.filePath}
        </span>
        <span className="ms-auto h-4 w-16 shrink-0 rounded-full bg-muted/70" />
      </div>
      <div className="space-y-1.5 p-2" aria-hidden="true">
        <div className="h-3 w-full rounded-full bg-muted/55" />
        <div className="h-3 w-11/12 rounded-full bg-muted/45" />
        <div className="h-3 w-4/5 rounded-full bg-muted/35" />
      </div>
    </div>
  );
}

function pushFileAnnotation(
  byFile: FileAnnotationMap,
  path: string,
  annotation: DiffLineAnnotation<ReviewLineAnnotationData>,
): void {
  const fileList = byFile.get(path);
  if (fileList) {
    fileList.push(annotation);
  } else {
    byFile.set(path, [annotation]);
  }
}

// Group saved comments and optimistic drafts into one annotation per file+line+side,
// so each anchored thread renders as a single @pierre/diffs annotation node. Submitted
// GitHub threads anchor as their own read-only annotations; general (path/line-less)
// remote threads are not anchorable and are skipped here (surfaced in the submit bar).
function formatFindingBody(finding: ReviewFinding): string {
  return `${finding.title}\n\n${finding.message}`;
}

function normalizeCommentBody(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function findingAlreadyCommented(input: {
  readonly finding: ReviewFinding;
  readonly comments: ReadonlyArray<ReviewLocalComment>;
  readonly drafts: ReadonlyArray<ReviewDraftComment>;
  readonly remoteThreads: ReadonlyArray<ReviewRemoteThread>;
}): boolean {
  const anchor = annotationAnchorKey(input.finding.path, input.finding.line, input.finding.side);
  const findingBody = normalizeCommentBody(formatFindingBody(input.finding));
  const findingMessage = normalizeCommentBody(input.finding.message);
  const matchesBody = (body: string) => {
    const normalized = normalizeCommentBody(body);
    return normalized === findingBody || normalized.includes(findingMessage);
  };
  return (
    input.comments.some(
      (comment) =>
        annotationAnchorKey(comment.path, comment.line, comment.side) === anchor &&
        matchesBody(comment.body),
    ) ||
    input.drafts.some(
      (draft) =>
        annotationAnchorKey(draft.path, draft.line, draft.side) === anchor &&
        matchesBody(draft.body),
    ) ||
    input.remoteThreads.some((thread) => {
      const side = thread.side ?? "RIGHT";
      return (
        thread.path !== undefined &&
        thread.line !== undefined &&
        annotationAnchorKey(thread.path, thread.line, side) === anchor &&
        thread.comments.some((comment) => matchesBody(comment.body))
      );
    })
  );
}

function buildAnnotationsByFile(
  comments: ReadonlyArray<ReviewLocalComment>,
  drafts: ReadonlyArray<ReviewDraftComment>,
  remoteThreads: ReadonlyArray<ReviewRemoteThread>,
  agentFindings: ReadonlyArray<ReviewFinding>,
): FileAnnotationMap {
  const grouped = new Map<
    string,
    {
      path: string;
      line: number;
      side: ReviewLocalComment["side"];
      comments: ReviewLocalComment[];
    }
  >();

  for (const comment of comments) {
    const key = annotationAnchorKey(comment.path, comment.line, comment.side);
    const existing = grouped.get(key);
    if (existing) {
      existing.comments.push(comment);
    } else {
      grouped.set(key, {
        path: comment.path,
        line: comment.line,
        side: comment.side,
        comments: [comment],
      });
    }
  }

  const draftByKey = new Map<string, ReviewDraftComment>();
  for (const draft of drafts) {
    const key = annotationAnchorKey(draft.path, draft.line, draft.side);
    draftByKey.set(key, draft);
    if (!grouped.has(key)) {
      grouped.set(key, { path: draft.path, line: draft.line, side: draft.side, comments: [] });
    }
  }

  const byFile: FileAnnotationMap = new Map();
  for (const [key, entry] of grouped) {
    const sortedComments = entry.comments.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const draft = draftByKey.get(key) ?? null;
    const data: ReviewLineAnnotationData = {
      kind: "local-draft",
      path: entry.path,
      line: entry.line,
      side: entry.side,
      comments: sortedComments,
      draft,
    };
    pushFileAnnotation(byFile, entry.path, {
      side: toAnnotationSide(entry.side),
      lineNumber: entry.line,
      metadata: data,
    });
  }

  for (const thread of remoteThreads) {
    if (!thread.path || thread.line === undefined) {
      continue;
    }
    const side = thread.side ?? "RIGHT";
    pushFileAnnotation(byFile, thread.path, {
      side: toAnnotationSide(side),
      lineNumber: thread.line,
      metadata: { kind: "submitted-thread", path: thread.path, line: thread.line, side, thread },
    });
  }

  for (const finding of agentFindings) {
    pushFileAnnotation(byFile, finding.path, {
      side: toAnnotationSide(finding.side),
      lineNumber: finding.line,
      metadata: {
        kind: "agent-finding",
        path: finding.path,
        line: finding.line,
        side: finding.side,
        finding,
      },
    });
  }
  return byFile;
}
