import type { DiffLineAnnotation } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useMemo } from "react";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import type { ReviewLineAnnotationData } from "./reviewAnnotations";
import type { ReviewDiffFileRow } from "./reviewDiffFileRows";
import { ReviewFileDiffBlock, type ReviewDraftAnchor } from "./ReviewFileDiffBlock";

type DiffRenderMode = "stacked" | "split";
type Density = "page" | "dock";

const EMPTY_ANNOTATIONS: DiffLineAnnotation<ReviewLineAnnotationData>[] = [];
const VIRTUAL_FILE_OVERSCAN = 3;
const PAGE_FILE_ESTIMATE_PX = 560;
const DOCK_FILE_ESTIMATE_PX = 420;
const COLLAPSED_FILE_ESTIMATE_PX = 42;

export const ReviewVirtualizedDiffFiles = memo(function ReviewVirtualizedDiffFiles(props: {
  files: ReadonlyArray<ReviewDiffFileRow>;
  scrollRef: RefObject<HTMLDivElement | null>;
  density: Density;
  theme: "light" | "dark";
  viewerIdentity: string;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  selectedFilePath: string | null;
  commentsEnabled: boolean;
  annotationsByFile: ReadonlyMap<
    string,
    ReadonlyArray<DiffLineAnnotation<ReviewLineAnnotationData>>
  >;
  viewedPaths?: ReadonlySet<string> | undefined;
  onToggleViewed?: ((path: string) => void) | undefined;
  isFileCollapsed: (fileKey: string, filePath: string) => boolean;
  onToggleFileCollapsed: (fileKey: string, filePath: string) => void;
  onStartDraft: (anchor: ReviewDraftAnchor) => void;
  renderAnnotation: (data: ReviewLineAnnotationData) => ReactNode;
}) {
  const selectedFileIndex = useMemo(() => {
    if (!props.selectedFilePath) return -1;
    return props.files.findIndex((row) => row.path === props.selectedFilePath);
  }, [props.files, props.selectedFilePath]);

  const rowVirtualizer = useVirtualizer({
    count: props.files.length,
    getScrollElement: () => props.scrollRef.current,
    estimateSize: (index) => {
      const row = props.files[index];
      if (!row) return props.density === "page" ? PAGE_FILE_ESTIMATE_PX : DOCK_FILE_ESTIMATE_PX;
      return props.isFileCollapsed(row.renderKey, row.path)
        ? COLLAPSED_FILE_ESTIMATE_PX
        : props.density === "page"
          ? PAGE_FILE_ESTIMATE_PX
          : DOCK_FILE_ESTIMATE_PX;
    },
    getItemKey: (index) => {
      const row = props.files[index];
      return row ? `${row.renderKey}:${props.theme}:${props.viewerIdentity}` : index;
    },
    overscan: VIRTUAL_FILE_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [
    props.diffRenderMode,
    props.diffWordWrap,
    props.viewedPaths,
    props.commentsEnabled,
    props.annotationsByFile,
    rowVirtualizer,
  ]);

  useEffect(() => {
    if (selectedFileIndex < 0) return;
    rowVirtualizer.scrollToIndex(selectedFileIndex, { align: "start" });
  }, [rowVirtualizer, selectedFileIndex]);

  const handleHeaderClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, fileKey: string, filePath: string) => {
      const nativeEvent = event.nativeEvent;
      const composedPath = nativeEvent.composedPath?.() ?? [];
      const clickedInteractive = composedPath.some((node) => {
        if (!(node instanceof Element)) return false;
        return Boolean(
          node.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]'),
        );
      });
      if (clickedInteractive) return;
      const clickedHeader = composedPath.some((node) => {
        if (!(node instanceof Element)) return false;
        return node.hasAttribute("data-diffs-header") || node.hasAttribute("data-file-info");
      });
      if (!clickedHeader) return;
      event.stopPropagation();
      props.onToggleFileCollapsed(fileKey, filePath);
    },
    [props.onToggleFileCollapsed],
  );

  return (
    <div
      className={cn(
        "relative min-h-full shrink-0",
        props.density === "page" ? "px-0 py-0" : "px-1",
      )}
      style={{ height: rowVirtualizer.getTotalSize() }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualItem) => {
        const row = props.files[virtualItem.index];
        if (!row) return null;
        const isCollapsed = props.isFileCollapsed(row.renderKey, row.path);
        const fileAnnotations = props.commentsEnabled
          ? (props.annotationsByFile.get(row.path) ?? EMPTY_ANNOTATIONS)
          : EMPTY_ANNOTATIONS;
        const toggleViewed = props.onToggleViewed;
        const onToggleReviewed = toggleViewed ? () => toggleViewed(row.path) : undefined;

        return (
          <div
            key={virtualItem.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualItem.index}
            data-diff-file-path={row.path}
            className={cn(
              "absolute left-0 top-0 w-full",
              props.density === "page"
                ? "diff-render-file scroll-mt-12"
                : "diff-render-file mb-3 scroll-mt-16 last:mb-0",
              props.selectedFilePath === row.path &&
                "before:absolute before:inset-y-0 before:left-0 before:z-20 before:w-0.5 before:bg-primary",
              props.selectedFilePath === row.path && props.density === "dock" && "before:rounded-l",
            )}
            style={{ transform: `translateY(${String(virtualItem.start)}px)` }}
            onClickCapture={(event) => handleHeaderClickCapture(event, row.renderKey, row.path)}
          >
            <LazyReviewFileDiffBlock
              row={row}
              theme={props.theme}
              diffStyle={props.diffRenderMode === "split" ? "split" : "unified"}
              overflow={props.diffWordWrap ? "wrap" : "scroll"}
              collapsed={isCollapsed}
              reviewed={props.viewedPaths?.has(row.path) ?? false}
              commentsEnabled={props.commentsEnabled}
              lineAnnotations={fileAnnotations}
              {...(onToggleReviewed ? { onToggleReviewed } : {})}
              onStartDraft={props.onStartDraft}
              renderAnnotation={props.renderAnnotation}
            />
          </div>
        );
      })}
    </div>
  );
});

const LazyReviewFileDiffBlock = memo(function LazyReviewFileDiffBlock(props: {
  row: ReviewDiffFileRow;
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  overflow: "scroll" | "wrap";
  collapsed: boolean;
  reviewed: boolean;
  commentsEnabled: boolean;
  lineAnnotations: ReadonlyArray<DiffLineAnnotation<ReviewLineAnnotationData>>;
  onToggleReviewed?: (() => void) | undefined;
  onStartDraft: (anchor: ReviewDraftAnchor) => void;
  renderAnnotation: (data: ReviewLineAnnotationData) => ReactNode;
}) {
  const fileDiff = useMemo(
    () => resolveRenderableFileDiff(props.row, props.theme),
    [props.row, props.theme],
  );

  if (!fileDiff) {
    return (
      <div className="overflow-hidden border-b border-border/40 bg-muted/40">
        <div className="flex h-8 items-center gap-2 border-b border-border/40 bg-muted/40 px-3">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {props.row.path}
          </span>
          <span className="ms-auto text-[10px] text-muted-foreground/75">
            Unable to render diff
          </span>
        </div>
      </div>
    );
  }

  return (
    <ReviewFileDiffBlock
      fileDiff={fileDiff}
      theme={props.theme}
      diffStyle={props.diffStyle}
      overflow={props.overflow}
      collapsed={props.collapsed}
      reviewed={props.reviewed}
      commentsEnabled={props.commentsEnabled}
      lineAnnotations={props.lineAnnotations}
      {...(props.onToggleReviewed ? { onToggleReviewed: props.onToggleReviewed } : {})}
      onStartDraft={props.onStartDraft}
      renderAnnotation={props.renderAnnotation}
    />
  );
});

function resolveRenderableFileDiff(
  row: ReviewDiffFileRow,
  theme: "light" | "dark",
): FileDiffMetadata | null {
  const renderable = getRenderablePatch(row.patchText, `review-file:${theme}:${row.renderKey}`);
  if (!renderable || renderable.kind !== "files") {
    return null;
  }
  return (
    renderable.files.find((fileDiff) => resolveFileDiffPath(fileDiff) === row.path) ??
    renderable.files[0] ??
    null
  );
}
