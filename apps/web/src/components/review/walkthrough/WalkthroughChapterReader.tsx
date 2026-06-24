import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { FileDiffCard, FileDiffSurface } from "../../chat/FileDiffView";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  InfoIcon,
} from "~/lib/icons";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { ChapterFindingCard, JudgmentCallout } from "./walkthroughChapterCards";
import { ProgressRing, ViewedToggle } from "./walkthroughPrimitives";

const MAX_DIFFS = 12;
const MAX_FINDINGS = 12;

export function WalkthroughChapterReader(props: {
  chapter: ReviewWalkthroughChapter;
  index: number;
  total: number;
  fileDiffs: readonly FileDiffMetadata[];
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  completed: boolean;
  viewedPaths: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  onToggleComplete: () => void;
  onNavigatePrevious: () => void;
  onNavigateNext: (() => void) | null;
}): ReactElement {
  const { chapter } = props;
  const uniqueFiles = useMemo(() => [...new Set(chapter.files)], [chapter.files]);
  const viewedCount = uniqueFiles.filter((path) => props.viewedPaths.has(path)).length;
  const findings = chapter.findings ?? [];

  const [showAllDiffs, setShowAllDiffs] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const visibleDiffs = showAllDiffs ? props.fileDiffs : props.fileDiffs.slice(0, MAX_DIFFS);
  const visibleFindings = showAllFindings ? findings : findings.slice(0, MAX_FINDINGS);
  const hiddenDiffs = props.fileDiffs.length - visibleDiffs.length;
  const hiddenFindings = findings.length - visibleFindings.length;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-7">
      <div>
        <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-4">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted font-mono text-[12px] leading-none tabular-nums text-foreground"
            >
              {props.index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h2
                tabIndex={-1}
                data-walkthrough-heading
                className="text-balance break-words [overflow-wrap:anywhere] rounded-sm text-[20px] font-semibold leading-7 tracking-[-0.01em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {chapter.title}
              </h2>
              {chapter.anchor ? (
                <p className="mt-0.5 break-words [overflow-wrap:anywhere] text-[12px] text-muted-foreground">
                  {chapter.anchor}
                </p>
              ) : null}
            </div>
          </div>
          {uniqueFiles.length > 0 ? (
            <ProgressRing viewed={viewedCount} total={uniqueFiles.length} />
          ) : null}
        </div>

        <ChapterExplanation chapter={chapter} />
      </div>

      <div className="mt-10">
        {props.fileDiffs.length > 0 ? (
          <FileDiffSurface className="space-y-3">
            <div className="space-y-3">
              {visibleDiffs.map((fileDiff) => {
                const resolved = resolveFileDiffPath(fileDiff);
                const path = uniqueFiles.includes(resolved) ? resolved : null;
                return (
                  <div key={fileDiff.cacheKey ?? fileDiff.name}>
                    <FileDiffCard
                      fileDiff={fileDiff}
                      theme={props.theme}
                      diffStyle={props.diffStyle}
                      {...(path !== null
                        ? {
                            renderHeaderMetadata: () => (
                              <ViewedToggle
                                viewed={props.viewedPaths.has(path)}
                                onToggle={() => props.onToggleViewed(path)}
                              />
                            ),
                          }
                        : {})}
                    />
                  </div>
                );
              })}
            </div>
            {hiddenDiffs > 0 ? (
              <ShowMoreButton
                count={hiddenDiffs}
                noun="files"
                onClick={() => setShowAllDiffs(true)}
              />
            ) : null}
          </FileDiffSurface>
        ) : (
          <div className="flex items-start gap-2.5 rounded-[0.625rem] border border-border/60 bg-muted/30 px-4 py-3 text-[12px] leading-5 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-info-foreground" />
            <span>No diff in this chapter. It sets up context for the changes that follow.</span>
          </div>
        )}
      </div>

      {findings.length > 0 ? (
        <section className="mt-10">
          <h3 className="mb-2 flex items-center gap-1.5 border-b border-border/40 pb-2 text-[15px] font-semibold text-foreground">
            <CircleAlertIcon className="size-3.5 text-destructive" />
            Findings
            <span className="tabular-nums text-muted-foreground">{findings.length}</span>
          </h3>
          <div className="space-y-3">
            {visibleFindings.map((finding) => (
              <ChapterFindingCard
                key={
                  finding.id ??
                  `${finding.path}:${finding.line}:${finding.title}:${finding.message}`
                }
                finding={finding}
              />
            ))}
          </div>
          {hiddenFindings > 0 ? (
            <ShowMoreButton
              count={hiddenFindings}
              noun="findings"
              className="mt-3"
              onClick={() => setShowAllFindings(true)}
            />
          ) : null}
        </section>
      ) : null}

      <nav
        aria-label="Chapter navigation"
        className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-4"
      >
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px] transition-[background-color,border-color,transform] duration-150 ease-out hover:border-border hover:bg-muted active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          aria-label={props.index <= 0 ? "Back to overview" : "Previous chapter"}
          onClick={props.onNavigatePrevious}
        >
          {props.index <= 0 ? (
            <ChevronUpIcon className="size-3.5" />
          ) : (
            <ChevronLeftIcon className="size-3.5" />
          )}
          {props.index <= 0 ? "Overview" : "Previous"}
        </Button>
        <Button
          size="sm"
          variant={props.completed ? "outline" : "prominent"}
          className={cn(
            "order-last w-full rounded-full px-3 text-[12px] transition-[background-color,border-color,color] duration-150 ease-out sm:order-none sm:w-auto",
            props.completed &&
              "border-success-foreground/40 bg-success/10 text-success-foreground hover:bg-success/16",
          )}
          aria-pressed={props.completed}
          onClick={props.onToggleComplete}
        >
          <span className="inline-grid size-3.5 shrink-0 place-items-center">
            <CheckIcon
              className={cn(
                "size-3.5 text-success-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none",
                props.completed ? "opacity-100" : "opacity-0",
              )}
            />
          </span>
          <span className="inline-block min-w-[6.75rem] text-center">
            {props.completed ? "Reviewed" : "Mark as reviewed"}
          </span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px] transition-[background-color,border-color,transform] duration-150 ease-out hover:border-border hover:bg-muted active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          aria-label={props.onNavigateNext ? "Next chapter" : "No more chapters"}
          disabled={props.onNavigateNext === null}
          onClick={() => props.onNavigateNext?.()}
        >
          Next
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </nav>
    </div>
  );
}

function ShowMoreButton(props: {
  count: number;
  noun: string;
  className?: string;
  onClick: () => void;
}): ReactElement {
  const label = props.count === 1 ? props.noun.replace(/s$/, "") : props.noun;
  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-[0.625rem] border border-dashed border-border/70 px-3 py-2 text-[12px] font-medium text-muted-foreground outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out hover:border-border hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        props.className,
      )}
      aria-label={`Show ${props.count} more ${label}`}
      onClick={props.onClick}
    >
      Show <span className="tabular-nums">{props.count}</span> more {label}
    </button>
  );
}

function ChapterExplanation(props: { chapter: ReviewWalkthroughChapter }): ReactElement {
  const { chapter } = props;
  return (
    <div className="mt-4 space-y-3">
      {chapter.summary ? (
        <p className="max-w-[68ch] text-pretty break-words text-[15px] leading-7 text-foreground/85">
          {chapter.summary}
        </p>
      ) : null}
      {chapter.intent ? (
        <p className="max-w-[68ch] text-pretty text-[13px] font-medium leading-5 text-foreground">
          {chapter.intent}
        </p>
      ) : null}
      {chapter.question ? <JudgmentCallout question={chapter.question} /> : null}
    </div>
  );
}
