import type { ReviewChangedFile, ReviewSourceRef, ReviewTargetKey } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { FileIcon, PanelLeftCloseIcon, PanelLeftIcon, SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewAgentBar } from "./ReviewAgentBar";
import { ReviewDiffPane } from "./ReviewDiffPane";
import { ReviewFileTree } from "./ReviewFileTree";
import { ReviewSubmitBar } from "./ReviewSubmitBar";
import { useReviewViewedFiles } from "./reviewViewedFiles";
import { useResizableReviewSidebar } from "./useResizableReviewSidebar";

const RAIL_WIDTH_BY_MODE = {
  dock: { min: 160, max: 320, default: 196 },
  page: { min: 220, max: 420, default: 272 },
} as const;

function railStorageKey(mode: "page" | "dock"): string {
  return `review:rail-width:${mode}`;
}

function railCollapsedStorageKey(mode: "page" | "dock"): string {
  return `review:file-rail-collapsed:${mode}`;
}

function initialRailCollapsed(mode: "page" | "dock"): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(railCollapsedStorageKey(mode)) === "true";
}

function saveRailCollapsed(mode: "page" | "dock", collapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(railCollapsedStorageKey(mode), String(collapsed));
  } catch {
    // Persisting rail chrome preferences is best-effort.
  }
}

function FileRailToggleButton(props: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const Icon = props.collapsed ? PanelLeftIcon : PanelLeftCloseIcon;
  return (
    <button
      type="button"
      aria-label={props.collapsed ? "Expand file tree" : "Collapse file tree"}
      aria-expanded={!props.collapsed}
      title={props.collapsed ? "Expand file tree" : "Collapse file tree"}
      onClick={() => props.onCollapsedChange(!props.collapsed)}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none",
        "transition-[background-color,color,opacity,transform] duration-150 motion-reduce:transition-none",
        "hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

export function ReviewLayout(props: {
  mode: "page" | "dock";
  files: ReadonlyArray<ReviewChangedFile>;
  patch: string | undefined;
  target: ReviewTargetKey | null;
  isLoading: boolean;
  error?: string | null;
  cwd?: string | null;
  source?: ReviewSourceRef | null;
  reference?: string | null;
  expectedHeadSha?: string | null;
  patchSignature?: string | null;
  selectedFilePath?: string | null;
  onSelectedFilePathChange?: (path: string | null) => void;
  reviewAction?: ReactNode;
  navigationAction?: ReactNode;
}) {
  const [uncontrolledSelectedFilePath, setUncontrolledSelectedFilePath] = useState<string | null>(
    null,
  );
  const [fileSearch, setFileSearch] = useState("");
  const selectedFilePath = props.selectedFilePath ?? uncontrolledSelectedFilePath;
  const setSelectedFilePath = props.onSelectedFilePathChange ?? setUncontrolledSelectedFilePath;
  const density = props.mode === "page" ? "page" : "dock";
  const railResize = useResizableReviewSidebar({
    bounds: RAIL_WIDTH_BY_MODE[props.mode],
    edge: "right",
    storageKey: railStorageKey(props.mode),
  });
  const [fileRailCollapsed, setFileRailCollapsed] = useState(() =>
    initialRailCollapsed(props.mode),
  );
  const showFileRail = true;

  const updateFileRailCollapsed = (collapsed: boolean) => {
    setFileRailCollapsed(collapsed);
    saveRailCollapsed(props.mode, collapsed);
  };

  const filePaths = useMemo(() => props.files.map((file) => file.path), [props.files]);
  const { viewedPaths, toggleViewed } = useReviewViewedFiles(props.target, filePaths);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of props.files) {
      additions += file.insertions;
      deletions += file.deletions;
    }
    return { files: props.files.length, additions, deletions };
  }, [props.files]);

  const filteredFiles = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    if (query.length === 0) {
      return props.files;
    }
    return props.files.filter((file) => file.path.toLowerCase().includes(query));
  }, [fileSearch, props.files]);

  const viewedProgress = useMemo(() => {
    let count = 0;
    for (const file of props.files) {
      if (viewedPaths.has(file.path)) {
        count += 1;
      }
    }
    return { count };
  }, [props.files, viewedPaths]);

  const resolvedSelectedFilePath = useMemo(() => {
    if (selectedFilePath && props.files.some((file) => file.path === selectedFilePath)) {
      return selectedFilePath;
    }
    return null;
  }, [props.files, selectedFilePath]);

  useEffect(() => {
    if (selectedFilePath !== null && resolvedSelectedFilePath === null) {
      setSelectedFilePath(null);
    }
  }, [resolvedSelectedFilePath, selectedFilePath, setSelectedFilePath]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 bg-background",
        props.mode === "page" && "review-files-workbench p-0",
      )}
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden",
          props.mode === "page" && "border-t border-border/35 bg-background dark:border-border/45",
        )}
      >
        {showFileRail && fileRailCollapsed ? (
          <aside
            className={cn(
              "hidden h-full min-h-0 w-12 shrink-0 flex-col items-center border-r bg-background py-2",
              props.mode === "page" ? "border-border/35 lg:flex" : "border-border/65 2xl:flex",
            )}
          >
            <FileRailToggleButton collapsed onCollapsedChange={updateFileRailCollapsed} />
            <div
              className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-2"
              aria-hidden="true"
            >
              <span className="flex size-8 items-center justify-center rounded-xl bg-muted/35 text-muted-foreground ring-1 ring-border/35">
                <FileIcon className="size-4" />
              </span>
              {totals.files > 0 ? (
                <span className="rounded-full bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums ring-1 ring-border/35">
                  {viewedProgress.count}/{totals.files}
                </span>
              ) : null}
              <span className="mt-1 [writing-mode:vertical-rl] text-[10px] font-semibold text-muted-foreground/75 uppercase tracking-wide">
                Files
              </span>
            </div>
          </aside>
        ) : showFileRail ? (
          <>
            <aside
              className={cn(
                "hidden min-h-0 shrink-0 flex-col border-r bg-background",
                props.mode === "page"
                  ? "border-border/35 bg-background lg:flex"
                  : "border-border/65 2xl:flex",
              )}
              style={{ width: railResize.width }}
            >
              <div className="flex shrink-0 flex-col gap-2 border-b border-border/25 bg-background px-3 py-2.5">
                <label className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border/35 bg-muted/25 px-2 text-muted-foreground focus-within:border-ring/55 focus-within:ring-2 focus-within:ring-ring/20">
                  <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  <input
                    value={fileSearch}
                    onChange={(event) => setFileSearch(event.currentTarget.value)}
                    placeholder="Search files..."
                    aria-label="Search changed files"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                    F
                  </span>
                </label>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold text-[12px] text-foreground/95">Files</h2>
                    <p className="truncate text-[11px] leading-4 text-muted-foreground/90">
                      {totals.files === 0
                        ? props.isLoading
                          ? "Loading changes"
                          : "No changes"
                        : `${totals.files} changed · ${totals.additions + totals.deletions} lines`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {totals.files > 0 ? (
                      <span className="shrink-0 rounded-full bg-muted/45 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums ring-1 ring-border/35">
                        {viewedProgress.count}/{totals.files}
                      </span>
                    ) : null}
                    <FileRailToggleButton
                      collapsed={false}
                      onCollapsedChange={updateFileRailCollapsed}
                    />
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ReviewFileTree
                  files={filteredFiles}
                  isLoading={props.isLoading}
                  selectedFilePath={resolvedSelectedFilePath}
                  onSelectFile={setSelectedFilePath}
                  viewedPaths={viewedPaths}
                  onToggleViewed={toggleViewed}
                  emptyMessage={
                    fileSearch.trim().length > 0
                      ? `No files match "${fileSearch.trim()}".`
                      : undefined
                  }
                />
              </div>
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file list"
              aria-valuemin={railResize.bounds.min}
              aria-valuemax={railResize.bounds.max}
              aria-valuenow={railResize.width}
              tabIndex={0}
              onDoubleClick={railResize.resetWidth}
              onPointerDown={railResize.handleResizeStart}
              onKeyDown={railResize.handleResizeKeyDown}
              className={cn(
                "-ms-px relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent outline-none",
                props.mode === "page" ? "hidden lg:block" : "hidden 2xl:block",
                "transition-colors duration-150 hover:bg-[var(--sidebar-accent)] focus-visible:bg-primary/30",
              )}
            />
          </>
        ) : null}
        <div
          className={cn(
            "relative flex h-full min-h-0 min-w-0 flex-1 flex-col",
            props.mode === "page" && "overflow-hidden bg-transparent",
          )}
        >
          <ReviewDiffPane
            patch={props.patch}
            target={props.target}
            isLoading={props.isLoading}
            error={props.error ?? null}
            selectedFilePath={resolvedSelectedFilePath}
            density={density}
            cwd={props.cwd ?? null}
            reference={props.reference ?? null}
            patchSignature={props.patchSignature ?? null}
            headSha={props.expectedHeadSha ?? null}
            summary={totals}
            viewedSummary={{ viewed: viewedProgress.count, total: totals.files }}
            viewedPaths={viewedPaths}
            files={props.files}
            onSelectFile={setSelectedFilePath}
            onToggleViewed={toggleViewed}
            reviewAction={props.reviewAction}
            navigationAction={props.navigationAction}
            agentControl={
              props.mode === "page" ? (
                <ReviewAgentBar
                  mode="inline"
                  cwd={props.cwd ?? null}
                  source={props.source ?? null}
                  target={props.target}
                  expectedHeadSha={props.expectedHeadSha ?? null}
                  patchSignature={props.patchSignature ?? null}
                />
              ) : props.mode === "dock" ? (
                <ReviewAgentBar
                  mode="dock"
                  cwd={props.cwd ?? null}
                  source={props.source ?? null}
                  target={props.target}
                  expectedHeadSha={props.expectedHeadSha ?? null}
                  patchSignature={props.patchSignature ?? null}
                />
              ) : null
            }
          />
          {props.mode === "dock" ? (
            <ReviewSubmitBar
              mode="dock"
              cwd={props.cwd ?? null}
              reference={props.reference ?? null}
              target={props.target}
              expectedHeadSha={props.expectedHeadSha ?? null}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
