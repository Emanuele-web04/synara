import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ReviewFinding, ReviewWalkthroughChapter } from "@t3tools/contracts";
import type { ReactElement } from "react";

import { FileDiffCard, FileDiffSurface } from "../../chat/FileDiffView";
import {
  BugIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  MessageCircleIcon,
} from "~/lib/icons";
import { Button } from "../../ui/button";
import { EmptyState, ReviewPill, severityPill } from "../reviewPrimitives";
import { ProgressRing, ViewedToggle } from "./walkthroughPrimitives";

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

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3 border-b border-border/35 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-muted/40 font-mono text-[12px] leading-none tabular-nums text-foreground">
            {props.index + 1}
          </span>
          <div className="min-w-0">
            <h2 className="text-balance text-[17px] font-semibold leading-6 text-foreground">
              {chapter.title}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{chapter.anchor}</p>
          </div>
        </div>
        <ProgressRing viewed={viewedCount} total={chapter.files.length} />
      </div>

      <ChapterExplanation chapter={chapter} />

      <div className="mt-4">
        {props.fileDiffs.length > 0 ? (
          <FileDiffSurface className="space-y-3">
            {props.fileDiffs.map((fileDiff) => (
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
          </FileDiffSurface>
        ) : (
          <EmptyState icon={<InfoIcon />} title="No diff to show">
            This chapter has no renderable file changes in the current patch.
          </EmptyState>
        )}
      </div>

      {findings.length > 0 ? (
        <section className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
            <BugIcon className="size-3.5 text-muted-foreground" />
            Findings
          </div>
          <div className="space-y-2.5">
            {findings.map((finding) => (
              <ChapterFindingCard
                key={finding.id ?? `${finding.path}:${finding.line}:${finding.title}`}
                finding={finding}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-2 border-t border-border/35 pt-4">
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px]"
          onClick={props.onNavigatePrevious}
        >
          <ChevronLeftIcon className="size-3.5" />
          {props.index <= 0 ? "Overview" : "Previous"}
        </Button>
        <Button
          size="sm"
          variant={props.completed ? "outline" : "prominent"}
          className="rounded-full px-3 text-[12px]"
          onClick={props.onToggleComplete}
        >
          <CheckIcon className="size-3.5" />
          {props.completed ? "Reviewed" : "Mark reviewed"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px]"
          disabled={props.onNavigateNext === null}
          onClick={() => props.onNavigateNext?.()}
        >
          Next
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ChapterExplanation(props: { chapter: ReviewWalkthroughChapter }): ReactElement {
  return (
    <div className="mt-3 space-y-3">
      <p className="max-w-2xl text-pretty text-[13px] leading-6 text-foreground">
        {props.chapter.summary}
      </p>
      <div className="rounded-lg border border-border/35 bg-muted/12 px-3.5 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <InfoIcon className="size-3.5" />
          Why it matters
        </div>
        <p className="text-[12px] leading-5 text-foreground">{props.chapter.intent}</p>
      </div>
      {props.chapter.question ? <JudgmentCallout question={props.chapter.question} /> : null}
    </div>
  );
}

function JudgmentCallout(props: { question: string }): ReactElement {
  return (
    <div className="mt-4 rounded-lg border border-info/30 bg-info/8 px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-info/15 text-info-foreground"
        >
          <MessageCircleIcon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-info-foreground">
            Judgment call
          </div>
          <p className="mt-1 text-[13px] leading-5 text-foreground">{props.question}</p>
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
    <article className="overflow-hidden rounded-lg border border-border/45 bg-background px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ReviewPill tone={severity.tone}>{severity.label}</ReviewPill>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {finding.path}:L{finding.line}
        </span>
      </div>
      <h4 className="mt-2 text-[13px] font-semibold leading-5 text-foreground">{finding.title}</h4>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{finding.message}</p>
    </article>
  );
}

// Match a parsed file diff back to a chapter file path so the viewed toggle can
// key off the same identity the rail and ProgressRing use.
function resolveDiffPathForToggle(
  fileDiff: FileDiffMetadata,
  chapterFiles: readonly string[],
): string | null {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  const stripped = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return chapterFiles.find((file) => file === stripped) ?? null;
}
