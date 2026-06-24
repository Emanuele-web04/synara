import type { ReviewChangedFile, ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { DiffStat, hasNonZeroStat } from "../../chat/DiffStatLabel";
import { ChevronRightIcon, EyeIcon, GitPullRequestIcon, SparklesIcon } from "~/lib/icons";
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
    <nav aria-label="Changes in PR" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/35 px-4 py-3">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Changes in PR</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          aria-current={props.reading === "overview" ? "true" : undefined}
          onClick={props.onOpenOverview}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            props.reading === "overview" ? "bg-muted/45" : "hover:bg-muted/15",
          )}
        >
          <span className="grid size-5 shrink-0 place-items-center rounded bg-muted/40 text-muted-foreground">
            <SparklesIcon className="size-3" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-foreground">Overview</span>
            <span className="block text-[11px] text-muted-foreground">
              Summary &amp; focus areas
            </span>
          </span>
        </button>
        {props.chapters.map((chapter, index) => (
          <WalkthroughChapterRailItem
            key={chapter.id}
            chapter={chapter}
            index={index}
            active={props.reading === chapter.id}
            filesByPath={props.filesByPath}
            viewedPaths={props.viewedPaths}
            onOpen={() => props.onOpenChapter(chapter)}
          />
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
      aria-current={props.active ? "true" : undefined}
      onClick={props.onOpen}
      className={cn(
        "flex w-full min-w-0 gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        props.active ? "bg-muted/45" : "hover:bg-muted/15",
      )}
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-muted/40 font-mono text-[11px] leading-none tabular-nums text-foreground">
        {props.index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-foreground">
          {chapter.title}
        </span>
        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {uniqueFiles.length} {uniqueFiles.length === 1 ? "file" : "files"}
          </span>
          {hasNonZeroStat(stat) ? (
            <DiffStat
              additions={stat.additions}
              deletions={stat.deletions}
              className="text-[11px]"
            />
          ) : (
            <span className="text-muted-foreground/70">no line changes</span>
          )}
        </span>
        <span className="mt-1.5 flex flex-col gap-0.5">
          {visibleFiles.map((path) => {
            const parts = splitRepoRelativePath(path);
            const viewed = props.viewedPaths.has(path);
            return (
              <span key={path} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
                  {parts.name}
                </span>
                {parts.dir ? (
                  <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                    {parts.dir}
                  </span>
                ) : null}
                {viewed ? <EyeIcon className="size-3 shrink-0 text-muted-foreground/70" /> : null}
              </span>
            );
          })}
          {remaining > 0 ? (
            <span className="font-mono text-[10px] text-muted-foreground/80">
              +{remaining} more {remaining === 1 ? "file" : "files"}
            </span>
          ) : null}
        </span>
        <span className="mt-2 inline-flex items-center gap-0.5 text-[11px] font-medium text-info-foreground">
          Explanation
          <ChevronRightIcon className="size-3" />
        </span>
      </span>
    </button>
  );
}
