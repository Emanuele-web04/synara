import type { ReviewChangedFile, ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { DiffStat, hasNonZeroStat } from "../../chat/DiffStatLabel";
import { CheckIcon, GitPullRequestIcon, SparklesIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { splitRepoRelativePath } from "~/lib/diffRendering";

export type WalkthroughReading = "overview" | string;

function chapterDiffStat(
  files: readonly string[],
  filesByPath: ReadonlyMap<string, ReviewChangedFile>,
): { additions: number; deletions: number } {
  return files.reduce(
    (totals, path) => {
      const file = filesByPath.get(path);
      return {
        additions: totals.additions + (file?.insertions ?? 0),
        deletions: totals.deletions + (file?.deletions ?? 0),
      };
    },
    { additions: 0, deletions: 0 },
  );
}

export function WalkthroughChapterRail(props: {
  chapters: readonly ReviewWalkthroughChapter[];
  reading: WalkthroughReading;
  filesByPath: ReadonlyMap<string, ReviewChangedFile>;
  viewedPaths: ReadonlySet<string>;
  onOpenOverview: () => void;
  onOpenChapter: (chapter: ReviewWalkthroughChapter) => void;
}): ReactElement {
  return (
    <nav aria-label="Changes" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-[1.125rem] py-3">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Changes
        </span>
      </div>
      <div
        role="list"
        className="min-h-0 flex-1 space-y-1 overflow-y-visible px-2 py-2 xl:overflow-y-auto"
      >
        <div role="listitem">
          <button
            type="button"
            aria-current={props.reading === "overview" ? "step" : undefined}
            onClick={props.onOpenOverview}
            className={cn(
              "relative flex w-full items-center gap-2 rounded-[0.625rem] px-2.5 py-2.5 text-left outline-none transition-[background-color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] pointer-coarse:after:absolute pointer-coarse:after:inset-0 pointer-coarse:after:min-h-11 motion-reduce:transition-none motion-reduce:active:scale-100",
              props.reading === "overview" ? "bg-muted hover:bg-muted/80" : "hover:bg-muted/40",
            )}
          >
            <span className="relative isolate grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
              <span
                className={cn(
                  "absolute inset-0 rounded-md bg-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none",
                  props.reading === "overview" ? "opacity-100" : "opacity-0",
                )}
              />
              <SparklesIcon
                className={cn(
                  "relative size-3",
                  props.reading === "overview" ? "text-background" : "text-muted-foreground",
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-[12px] transition-colors duration-150 ease-out motion-reduce:transition-none",
                  props.reading === "overview"
                    ? "font-semibold text-foreground"
                    : "font-medium text-muted-foreground",
                )}
              >
                Overview
              </span>
            </span>
          </button>
        </div>
        {props.chapters.map((chapter, index) => (
          <div role="listitem" key={chapter.id}>
            <WalkthroughChapterRailItem
              chapter={chapter}
              index={index}
              active={props.reading === chapter.id}
              filesByPath={props.filesByPath}
              viewedPaths={props.viewedPaths}
              onOpen={() => props.onOpenChapter(chapter)}
            />
          </div>
        ))}
      </div>
    </nav>
  );
}

function WalkthroughChapterRailItem(props: {
  chapter: ReviewWalkthroughChapter;
  index: number;
  active: boolean;
  filesByPath: ReadonlyMap<string, ReviewChangedFile>;
  viewedPaths: ReadonlySet<string>;
  onOpen: () => void;
}): ReactElement {
  const { chapter, filesByPath } = props;
  const uniqueFiles = useMemo(() => [...new Set(chapter.files)], [chapter.files]);
  const stat = useMemo(() => chapterDiffStat(uniqueFiles, filesByPath), [uniqueFiles, filesByPath]);
  const visibleFiles = uniqueFiles.slice(0, 3);
  const remaining = uniqueFiles.length - visibleFiles.length;
  return (
    <button
      type="button"
      aria-current={props.active ? "step" : undefined}
      aria-label={`Chapter ${props.index + 1}: ${chapter.title}`}
      onClick={props.onOpen}
      className={cn(
        "relative flex w-full min-w-0 gap-2.5 rounded-[0.625rem] px-2.5 py-2.5 text-left outline-none transition-[background-color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] pointer-coarse:after:absolute pointer-coarse:after:inset-0 pointer-coarse:after:min-h-11 motion-reduce:transition-none motion-reduce:active:scale-100",
        props.active ? "bg-muted hover:bg-muted/80" : "hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden="true"
        className="relative isolate mt-0.5 grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-muted font-mono text-[11px] leading-none tabular-nums"
      >
        <span
          className={cn(
            "absolute inset-0 rounded-md bg-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none",
            props.active ? "opacity-100" : "opacity-0",
          )}
        />
        <span className={cn("relative", props.active ? "text-background" : "text-foreground")}>
          {props.index + 1}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span
          title={chapter.title}
          className={cn(
            "block truncate text-[12px] transition-colors duration-150 ease-out motion-reduce:transition-none",
            props.active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          )}
        >
          {chapter.title}
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {uniqueFiles.length} {uniqueFiles.length === 1 ? "file" : "files"}
          </span>
          {hasNonZeroStat(stat) ? (
            <DiffStat
              additions={stat.additions}
              deletions={stat.deletions}
              className="shrink-0 whitespace-nowrap text-[11px]"
            />
          ) : (
            <span className="shrink-0 text-muted-foreground">no line changes</span>
          )}
        </span>
        {visibleFiles.length > 0 ? (
          <span className="mt-2 flex flex-col gap-1">
            {visibleFiles.map((path) => {
              const parts = splitRepoRelativePath(path);
              const viewed = props.viewedPaths.has(path);
              return (
                <span
                  key={path}
                  aria-label={`${parts.name} ${viewed ? "viewed" : "not viewed"}`}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <span
                    title={parts.name}
                    className="min-w-0 flex-[2_1_0%] truncate font-mono text-[11px] font-medium text-foreground"
                  >
                    {parts.name}
                  </span>
                  {parts.dir ? (
                    <span
                      title={parts.dir}
                      className="min-w-0 max-w-[40%] flex-[0_1_auto] truncate font-mono text-[11px] text-muted-foreground"
                    >
                      {parts.dir}
                    </span>
                  ) : null}
                  <CheckIcon
                    className={cn(
                      "size-3 shrink-0 text-success-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none",
                      viewed ? "opacity-100" : "opacity-0",
                    )}
                  />
                </span>
              );
            })}
            {remaining > 0 ? (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                +{remaining} more {remaining === 1 ? "file" : "files"}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}
