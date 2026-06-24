import { autoAnimate } from "@formkit/auto-animate";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useRef, useState } from "react";

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
import { EmptyState } from "../reviewPrimitives";
import { ChapterFindingCard, JudgmentCallout } from "./walkthroughChapterCards";
import {
  ProgressRing,
  ViewedToggle,
  WALKTHROUGH_LIST_ANIMATION,
  WALKTHROUGH_STAGGER_CAP,
  WALKTHROUGH_STAGGER_STEP_MS,
} from "./walkthroughPrimitives";

const MAX_DIFFS = 12;
const MAX_FINDINGS = 12;

const ITEM_ENTER =
  "animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out fill-mode-both motion-reduce:animate-none";
const staggerStyle = (index: number): CSSProperties => ({
  animationDelay: `${Math.min(index, WALKTHROUGH_STAGGER_CAP) * WALKTHROUGH_STAGGER_STEP_MS}ms`,
});

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
  const viewedCount = chapter.files.filter((path) => props.viewedPaths.has(path)).length;
  const findings = chapter.findings ?? [];

  const [showAllDiffs, setShowAllDiffs] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const visibleDiffs = showAllDiffs ? props.fileDiffs : props.fileDiffs.slice(0, MAX_DIFFS);
  const visibleFindings = showAllFindings ? findings : findings.slice(0, MAX_FINDINGS);
  const hiddenDiffs = props.fileDiffs.length - visibleDiffs.length;
  const hiddenFindings = findings.length - visibleFindings.length;

  const animatedListsRef = useRef(new WeakSet<HTMLElement>());
  const attachListAutoAnimate = useCallback((node: HTMLElement | null): void => {
    if (node && !animatedListsRef.current.has(node)) {
      autoAnimate(node, WALKTHROUGH_LIST_ANIMATION);
      animatedListsRef.current.add(node);
    }
  }, []);

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div>
        <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-4">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-muted/40 font-mono text-[12px] leading-none tabular-nums text-muted-foreground">
              {props.index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h2
                tabIndex={-1}
                className="text-balance break-words [overflow-wrap:anywhere] rounded-sm text-[18px] font-semibold leading-7 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {chapter.title}
              </h2>
              {chapter.anchor ? (
                <p className="mt-0.5 break-words text-[12px] text-muted-foreground">
                  {chapter.anchor}
                </p>
              ) : null}
            </div>
          </div>
          <ProgressRing viewed={viewedCount} total={chapter.files.length} />
        </div>

        <ChapterExplanation chapter={chapter} />
      </div>

      <div className="mt-8 animate-in fade-in duration-200 ease-out delay-[60ms] fill-mode-both motion-reduce:animate-none">
        {props.fileDiffs.length > 0 ? (
          <FileDiffSurface className="space-y-3">
            <div className="space-y-3">
              {visibleDiffs.map((fileDiff, index) => {
                const resolved = resolveFileDiffPath(fileDiff);
                const path = chapter.files.includes(resolved) ? resolved : null;
                return (
                  <div
                    key={fileDiff.cacheKey ?? fileDiff.name}
                    className={showAllDiffs ? undefined : ITEM_ENTER}
                    style={showAllDiffs ? undefined : staggerStyle(index)}
                  >
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
          <EmptyState icon={<InfoIcon />} title="No file changes">
            This chapter explains context rather than a specific diff.
          </EmptyState>
        )}
      </div>

      {findings.length > 0 ? (
        <section className="mt-6 animate-in fade-in duration-200 ease-out delay-[120ms] fill-mode-both motion-reduce:animate-none">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <CircleAlertIcon className="size-3.5" />
            Findings
          </h3>
          <div ref={attachListAutoAnimate} className="space-y-3">
            {visibleFindings.map((finding, index) => (
              <ChapterFindingCard
                key={
                  finding.id ??
                  `${finding.path}:${finding.line}:${finding.title}:${finding.message}`
                }
                finding={finding}
                {...(showAllFindings ? {} : { className: ITEM_ENTER, style: staggerStyle(index) })}
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
        className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-4"
      >
        <Button
          size="sm"
          variant="outline"
          className="group rounded-full px-3 text-[12px] transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted/30 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          aria-label={props.index <= 0 ? "Back to overview" : "Previous chapter"}
          onClick={props.onNavigatePrevious}
        >
          {props.index <= 0 ? (
            <ChevronUpIcon className="size-3.5" />
          ) : (
            <ChevronLeftIcon className="size-3.5 transition-transform duration-150 ease-out group-hover:-translate-x-0.5 motion-reduce:transition-none" />
          )}
          {props.index <= 0 ? "Overview" : "Previous"}
        </Button>
        <Button
          size="sm"
          variant={props.completed ? "outline" : "prominent"}
          className="order-last w-full rounded-full px-3 text-[12px] transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 sm:order-none sm:w-auto"
          aria-pressed={props.completed}
          onClick={props.onToggleComplete}
        >
          <span className="inline-grid size-3.5 shrink-0 place-items-center">
            <CheckIcon
              className={cn(
                "size-3.5 text-success-foreground transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                props.completed ? "scale-100 opacity-100" : "scale-75 opacity-0",
              )}
            />
          </span>
          <span className="inline-block min-w-[6.75rem] text-center transition-colors duration-150 ease-out motion-reduce:transition-none">
            {props.completed ? "Reviewed" : "Mark as reviewed"}
          </span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="group rounded-full px-3 text-[12px] transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted/30 active:scale-[0.98] disabled:opacity-50 disabled:hover:bg-transparent disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100"
          aria-label={props.onNavigateNext ? "Next chapter" : "No more chapters"}
          disabled={props.onNavigateNext === null}
          onClick={() => props.onNavigateNext?.()}
        >
          Next
          <ChevronRightIcon className="size-3.5 transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none" />
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
        "w-full rounded-[0.625rem] border border-dashed border-border/40 px-3 py-2 text-[12px] font-medium text-muted-foreground outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out hover:border-border hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        props.className,
      )}
      aria-label={`Show ${props.count} more ${label}`}
      onClick={props.onClick}
    >
      Show <span className="tabular-nums">{props.count}</span> more {label}
    </button>
  );
}

function ChapterExplanation(props: { chapter: ReviewWalkthroughChapter }): ReactElement | null {
  const { chapter } = props;
  if (!chapter.summary && !chapter.intent && !chapter.question) {
    return null;
  }
  return (
    <div className="mt-4 space-y-3">
      {chapter.summary ? (
        <p className="max-w-2xl text-pretty break-words text-[14px] leading-6 text-foreground">
          {chapter.summary}
        </p>
      ) : null}
      {chapter.intent ? (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <InfoIcon className="size-3.5" />
            Why it matters
          </div>
          <p className="text-pretty text-[13px] leading-5 text-foreground">{chapter.intent}</p>
        </div>
      ) : null}
      {chapter.question ? <JudgmentCallout question={chapter.question} /> : null}
    </div>
  );
}
