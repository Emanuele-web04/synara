import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ReviewFinding, ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { useState } from "react";

import { FileDiffCard, FileDiffSurface } from "../../chat/FileDiffView";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  InfoIcon,
  MessageCircleIcon,
} from "~/lib/icons";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import { Button } from "../../ui/button";
import { EmptyState, ReviewPill, severityPill } from "../reviewPrimitives";
import { ProgressRing, ViewedToggle } from "./walkthroughPrimitives";

const MAX_DIFFS = 50;
const MAX_FINDINGS = 50;

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

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-muted/40 font-mono text-[12px] leading-none tabular-nums text-muted-foreground">
            {props.index + 1}
          </span>
          <div className="min-w-0">
            <h2
              tabIndex={-1}
              className="text-balance rounded-sm text-[18px] font-semibold leading-7 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {chapter.title}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{chapter.anchor}</p>
          </div>
        </div>
        <ProgressRing viewed={viewedCount} total={chapter.files.length} />
      </div>

      <ChapterExplanation chapter={chapter} />

      <div className="mt-8">
        {props.fileDiffs.length > 0 ? (
          <FileDiffSurface className="space-y-3">
            {visibleDiffs.map((fileDiff) => (
              <ChapterFileDiff
                key={fileDiff.cacheKey ?? fileDiff.name}
                fileDiff={fileDiff}
                theme={props.theme}
                diffStyle={props.diffStyle}
                path={resolveDiffPathForToggle(fileDiff, chapter.files)}
                viewedPaths={props.viewedPaths}
                onToggleViewed={props.onToggleViewed}
              />
            ))}
            {hiddenDiffs > 0 ? (
              <button
                type="button"
                className="w-full rounded-[0.625rem] border border-dashed border-border/40 px-3 py-2 text-[12px] font-medium text-muted-foreground outline-none transition-[color,border-color] hover:border-border/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
                aria-label={`Show ${hiddenDiffs} more files`}
                onClick={() => setShowAllDiffs(true)}
              >
                Show <span className="tabular-nums">{hiddenDiffs}</span> more files
              </button>
            ) : null}
          </FileDiffSurface>
        ) : (
          <EmptyState icon={<InfoIcon />} title="No file changes">
            This chapter explains context rather than a specific diff.
          </EmptyState>
        )}
      </div>

      {findings.length > 0 ? (
        <section className="mt-6">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <CircleAlertIcon className="size-3.5" />
            Findings
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
            {hiddenFindings > 0 ? (
              <button
                type="button"
                className="w-full rounded-[0.625rem] border border-dashed border-border/40 px-3 py-2 text-[12px] font-medium text-muted-foreground outline-none transition-[color,border-color] hover:border-border/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
                aria-label={`Show ${hiddenFindings} more findings`}
                onClick={() => setShowAllFindings(true)}
              >
                Show <span className="tabular-nums">{hiddenFindings}</span> more findings
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <nav
        aria-label="Chapter navigation"
        className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-4"
      >
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px] transition-transform duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
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
          className="order-last w-full rounded-full px-3 text-[12px] transition-colors duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 sm:order-none sm:w-auto"
          aria-pressed={props.completed}
          onClick={props.onToggleComplete}
        >
          <CheckIcon className="size-3.5" />
          {props.completed ? "Reviewed" : "Mark as reviewed"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px] transition-transform duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
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

function ChapterExplanation(props: { chapter: ReviewWalkthroughChapter }): ReactElement {
  return (
    <div className="mt-4 space-y-3">
      <p className="max-w-2xl text-pretty break-words text-[14px] leading-6 text-foreground">
        {props.chapter.summary}
      </p>
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <InfoIcon className="size-3.5" />
          Why it matters
        </div>
        <p className="text-pretty text-[13px] leading-5 text-foreground">{props.chapter.intent}</p>
      </div>
      {props.chapter.question ? <JudgmentCallout question={props.chapter.question} /> : null}
    </div>
  );
}

function JudgmentCallout(props: { question: string }): ReactElement {
  return (
    <div className="rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-info/12 text-info-foreground"
        >
          <MessageCircleIcon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-foreground">Judgment call</div>
          <p className="mt-1 text-pretty text-[13px] leading-5 text-foreground">{props.question}</p>
        </div>
      </div>
    </div>
  );
}

function ChapterFileDiff(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  diffStyle: "unified" | "split";
  path: string | null;
  viewedPaths: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
}): ReactElement {
  const path = props.path;
  const viewed = path !== null && props.viewedPaths.has(path);
  return (
    <FileDiffCard
      fileDiff={props.fileDiff}
      theme={props.theme}
      diffStyle={props.diffStyle}
      {...(path !== null
        ? {
            renderHeaderMetadata: () => (
              <ViewedToggle viewed={viewed} onToggle={() => props.onToggleViewed(path)} />
            ),
          }
        : {})}
    />
  );
}

function ChapterFindingCard(props: { finding: ReviewFinding }): ReactElement {
  const { finding } = props;
  const severity = severityPill(finding.severity);
  return (
    <article className="overflow-hidden rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3 transition-colors duration-150 hover:border-border motion-reduce:transition-none">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ReviewPill tone={severity.tone}>{severity.label}</ReviewPill>
        <span className="flex w-full min-w-0">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {finding.path}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            :{finding.line}
          </span>
        </span>
      </div>
      <h4 className="mt-2 text-[13px] font-semibold leading-5 text-foreground">{finding.title}</h4>
      <p className="mt-1 text-[12px] leading-5 text-foreground">{finding.message}</p>
    </article>
  );
}

function resolveDiffPathForToggle(
  fileDiff: FileDiffMetadata,
  chapterFiles: readonly string[],
): string | null {
  const path = resolveFileDiffPath(fileDiff);
  return chapterFiles.includes(path) ? path : null;
}
