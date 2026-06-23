// Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V4
// FILE: ReviewWalkthroughPrototype.tsx
// Purpose: PROTOTYPE - interactive PR walkthrough UI variants for review-surface design.
// Layer: Throwaway review UI prototype mounted from /review?prototypeWalkthrough=1.

import type {
  ReviewChangedFile,
  ReviewCheck,
  ReviewFindingSeverity,
  ReviewPullRequestDetail,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { DiffStat } from "../chat/DiffStatLabel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  BugIcon,
  CheckIcon,
  ClockIcon,
  CircleAlertIcon,
  DiffIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InfoIcon,
  Loader2Icon,
  MessageCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { CheckStateIcon, LabelPill } from "./reviewPrPrimitives";
import { ReviewFileTree } from "./ReviewFileTree";
import { ReviewPrHeader } from "./ReviewPrHeader";
import { ReviewPill, severityPill } from "./reviewPrimitives";

export type WalkthroughPrototypeVariant = "rail" | "focus" | "board";

export const WALKTHROUGH_PROTOTYPE_VARIANTS: ReadonlyArray<{
  id: WalkthroughPrototypeVariant;
  label: string;
}> = [
  { id: "rail", label: "Desk" },
  { id: "focus", label: "Case" },
  { id: "board", label: "Matrix" },
];

interface WalkthroughChapter {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly intent: string;
  readonly anchor: string;
  readonly risk: ReviewFindingSeverity;
  readonly files: readonly string[];
  readonly hunk: string;
  readonly question: string;
  readonly status: "done" | "active" | "queued";
}

interface RunStep {
  readonly label: string;
  readonly detail: string;
  readonly state: "success" | "pending" | "failure";
}

interface ReviewFinding {
  readonly id: string;
  readonly category: "bug" | "flag" | "security";
  readonly severity: ReviewFindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly file: string;
  readonly line: number;
  readonly suggestedFix: string;
  readonly status: "open" | "queued" | "resolved";
}

type AnalysisSignalKind = "finding" | "check" | "question" | "coverage";

interface AnalysisSignal {
  readonly id: string;
  readonly kind: AnalysisSignalKind;
  readonly priority: ReviewFindingSeverity;
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly action: string;
  readonly status: "open" | "waiting" | "resolved";
  readonly findingId: string | null;
  readonly chapterId: string | null;
  readonly file: string | null;
  readonly line: number | null;
}

const FINDINGS: readonly ReviewFinding[] = [
  {
    id: "finding-cache",
    category: "bug",
    severity: "blocker",
    title: "Walkthrough freshness can drift",
    summary:
      "The generated overview depends on patch shape. A new push needs to invalidate the artifact before review starts.",
    file: "apps/web/src/lib/reviewReactQuery.ts",
    line: 44,
    suggestedFix: "Include head SHA and patch signature in the walkthrough cache key.",
    status: "open",
  },
  {
    id: "finding-generated",
    category: "flag",
    severity: "major",
    title: "Generated hunks need a bucket",
    summary:
      "Lockfiles and generated output should stay visible without dominating the chapter order.",
    file: "apps/server/src/review/parseUnifiedDiffHunks.ts",
    line: 92,
    suggestedFix: "Group generated files under Other changes and keep them in final coverage.",
    status: "queued",
  },
  {
    id: "finding-latency",
    category: "flag",
    severity: "minor",
    title: "Open latency is not isolated",
    summary:
      "The performance test proves the PR route stays lean, but walkthrough-open latency needs its own number.",
    file: "apps/web/src/components/review/ReviewPrView.performance.browser.tsx",
    line: 366,
    suggestedFix: "Track walkthrough-open timing separately from default PR hydration.",
    status: "queued",
  },
];

const RUN_STEPS: readonly RunStep[] = [
  {
    label: "Read PR metadata",
    detail: "Loaded checks, changed files, reviewers, and branch state.",
    state: "success",
  },
  {
    label: "Cluster diff hunks",
    detail: "Grouped related hunks by dependency and reviewer intent.",
    state: "success",
  },
  {
    label: "Map judgment calls",
    detail: "Found questions that need product or team context.",
    state: "failure",
  },
  {
    label: "Watch CI",
    detail: "Waiting on benchmark:review before final confidence.",
    state: "pending",
  },
];

const REVIEW_DETAIL = {
  number: 124,
  title: "Add PR walkthroughs to the review interface",
  url: "https://github.com/synara/synara/pull/124",
  state: "open",
  isDraft: false,
  author: "tyler",
  baseBranch: "main",
  headBranch: "feat/pr-walkthrough",
  body: "Prototype a guided review path that organizes a PR into chapters with evidence-backed anchors.",
  createdAt: "2026-06-22T15:13:00.000Z",
  updatedAt: "2026-06-23T16:18:00.000Z",
  additions: 420,
  deletions: 118,
  changedFiles: 7,
  commitsCount: 5,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  checksStatus: "failing",
  milestone: null,
  labels: [
    { name: "review-surface", color: "60a5fa" },
    { name: "prototype", color: "a78bfa" },
  ],
  assignees: [{ login: "tyler" }],
  reviewers: [
    { login: "mira", state: "REVIEW_REQUIRED" },
    { login: "sam", state: "COMMENTED" },
  ],
} satisfies ReviewPullRequestDetail;

const CHANGED_FILES: readonly ReviewChangedFile[] = [
  { path: "apps/web/src/components/review/ReviewPrView.tsx", insertions: 96, deletions: 24 },
  {
    path: "apps/web/src/components/review/ReviewWalkthroughPanel.tsx",
    insertions: 148,
    deletions: 0,
    status: "added",
  },
  { path: "apps/web/src/lib/reviewReactQuery.ts", insertions: 42, deletions: 12 },
  { path: "apps/server/src/review/Layers/ReviewWalkthrough.ts", insertions: 72, deletions: 19 },
  { path: "apps/server/src/review/parseUnifiedDiffHunks.ts", insertions: 58, deletions: 4 },
  { path: "packages/contracts/src/review.ts", insertions: 34, deletions: 9 },
  { path: "apps/web/src/components/review/ReviewPrView.performance.browser.tsx", insertions: 28, deletions: 50 },
];

const CHECKS: readonly ReviewCheck[] = [
  { name: "web typecheck", state: "success" },
  { name: "review browser tests", state: "failure", description: "stale walkthrough banner" },
  { name: "server unit", state: "success" },
  { name: "benchmark:review", state: "pending" },
];

const CHAPTERS: readonly WalkthroughChapter[] = [
  {
    id: "foundation",
    title: "Define the walkthrough contract",
    summary: "Schema and query keys establish a durable artifact instead of another chat answer.",
    intent: "Make the walkthrough cacheable, refreshable, and safe to rerun.",
    anchor: "contracts + query key",
    risk: "major",
    files: ["packages/contracts/src/review.ts", "apps/web/src/lib/reviewReactQuery.ts"],
    hunk: "@@ -341,6 +412,48 @@ export const ReviewAgentResult = Schema.Struct({",
    question: "Does the cache key include enough freshness metadata for rerereviews?",
    status: "done",
  },
  {
    id: "cluster",
    title: "Cluster hunks into review stages",
    summary: "Server parsing turns raw unified diff hunks into chapter candidates with stable anchors.",
    intent: "Give reviewers a causal reading order instead of a file-order tour.",
    anchor: "parser + stage generator",
    risk: "blocker",
    files: [
      "apps/server/src/review/parseUnifiedDiffHunks.ts",
      "apps/server/src/review/Layers/ReviewWalkthrough.ts",
    ],
    hunk: "@@ -1,0 +1,92 @@ export function parseUnifiedDiffHunks(patch: string)",
    question: "Should generated and lockfile hunks be skipped or grouped under other changes?",
    status: "active",
  },
  {
    id: "surface",
    title: "Mount the guided review surface",
    summary: "The PR view gets a walkthrough mode without changing the existing Files hydration path.",
    intent: "Keep Files as the source of truth while adding a guided overview layer.",
    anchor: "review route + panel",
    risk: "major",
    files: [
      "apps/web/src/components/review/ReviewPrView.tsx",
      "apps/web/src/components/review/ReviewWalkthroughPanel.tsx",
    ],
    hunk: "@@ -102,7 +124,18 @@ type PrTab = \"conversation\" | \"files\" | \"commits\";",
    question: "Is Walkthrough a primary tab or a persistent rail while Files stays open?",
    status: "queued",
  },
  {
    id: "proof",
    title: "Protect the performance path",
    summary: "Browser coverage keeps walkthrough generation explicit and prevents eager diff hydration.",
    intent: "Make the new overview measurable without slowing the default PR route.",
    anchor: "browser coverage",
    risk: "minor",
    files: ["apps/web/src/components/review/ReviewPrView.performance.browser.tsx"],
    hunk: "@@ -321,6 +366,28 @@ expect(nativeApiMock.loadPullRequestSurface)",
    question: "Should the benchmark track walkthrough open latency separately from PR view latency?",
    status: "queued",
  },
];

const ANALYSIS_SIGNALS: readonly AnalysisSignal[] = buildAnalysisSignals();

export function ReviewWalkthroughPrototype(props: {
  variant: WalkthroughPrototypeVariant;
  onVariantChange: (variant: WalkthroughPrototypeVariant) => void;
}): ReactElement {
  const initialSignal =
    ANALYSIS_SIGNALS.find((signal) => signal.findingId === "finding-cache") ??
    ANALYSIS_SIGNALS[0]!;
  const initialChapter =
    CHAPTERS.find((chapter) => chapter.id === initialSignal.chapterId) ??
    CHAPTERS.find((chapter) => chapter.status === "active") ??
    CHAPTERS[0]!;
  const [activeChapterId, setActiveChapterId] = useState(initialChapter.id);
  const [selectedFilePath, setSelectedFilePath] = useState(
    initialSignal.file ?? initialChapter.files[0] ?? null,
  );
  const [selectedFindingId, setSelectedFindingId] = useState(
    initialSignal.findingId ?? findingsForChapter(initialChapter)[0]?.id ?? FINDINGS[0]?.id ?? null,
  );
  const [selectedSignalId, setSelectedSignalId] = useState(initialSignal.id);
  const [viewedPaths, setViewedPaths] = useState<ReadonlySet<string>>(
    () => new Set(["packages/contracts/src/review.ts"]),
  );
  const [completedChapterIds, setCompletedChapterIds] = useState<ReadonlySet<string>>(
    () => new Set(["foundation"]),
  );
  const [stale, setStale] = useState(true);
  const [generating, setGenerating] = useState(false);
  const generationTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (generationTimeoutRef.current !== null) {
        window.clearTimeout(generationTimeoutRef.current);
      }
    },
    [],
  );

  const activeChapter =
    CHAPTERS.find((chapter) => chapter.id === activeChapterId) ?? CHAPTERS[0]!;
  const selectedFile = CHANGED_FILES.find((file) => file.path === selectedFilePath) ?? null;
  const selectedFinding = FINDINGS.find((finding) => finding.id === selectedFindingId) ?? null;
  const selectedSignal =
    ANALYSIS_SIGNALS.find((signal) => signal.id === selectedSignalId) ?? ANALYSIS_SIGNALS[0]!;

  const toggleViewed = (path: string): void => {
    setViewedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectChapter = (chapter: WalkthroughChapter): void => {
    const firstFinding = findingsForChapter(chapter)[0] ?? null;
    setActiveChapterId(chapter.id);
    setSelectedFilePath(chapter.files[0] ?? null);
    setSelectedFindingId(firstFinding?.id ?? null);
    setSelectedSignalId(firstFinding ? signalIdForFinding(firstFinding) : signalIdForChapter(chapter));
  };

  const selectFinding = (finding: ReviewFinding): void => {
    const matchingChapter = CHAPTERS.find((chapter) => chapter.files.includes(finding.file));
    if (matchingChapter) {
      setActiveChapterId(matchingChapter.id);
    }
    setSelectedFindingId(finding.id);
    setSelectedSignalId(signalIdForFinding(finding));
    setSelectedFilePath(finding.file);
  };

  const selectFile = (path: string): void => {
    const finding = FINDINGS.find((candidate) => candidate.file === path) ?? null;
    setSelectedFilePath(path);
    if (finding) {
      const matchingChapter = CHAPTERS.find((chapter) => chapter.files.includes(finding.file));
      if (matchingChapter) {
        setActiveChapterId(matchingChapter.id);
      }
      setSelectedFindingId(finding.id);
      setSelectedSignalId(signalIdForFinding(finding));
      return;
    }
    setSelectedFindingId(null);
  };

  const selectSignal = (signal: AnalysisSignal): void => {
    setSelectedSignalId(signal.id);
    if (signal.findingId !== null) {
      const finding = FINDINGS.find((candidate) => candidate.id === signal.findingId);
      if (finding) {
        selectFinding(finding);
        return;
      }
    }
    if (signal.chapterId !== null) {
      const chapter = CHAPTERS.find((candidate) => candidate.id === signal.chapterId);
      if (chapter) {
        setActiveChapterId(chapter.id);
        setSelectedFindingId(null);
        setSelectedFilePath(signal.file ?? chapter.files[0] ?? null);
        return;
      }
    }
    setSelectedFindingId(null);
    setSelectedFilePath(signal.file);
  };

  const toggleChapterComplete = (chapterId: string): void => {
    setCompletedChapterIds((previous) => {
      const next = new Set(previous);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  };

  const regenerate = (): void => {
    setGenerating(true);
    setStale(false);
    if (generationTimeoutRef.current !== null) {
      window.clearTimeout(generationTimeoutRef.current);
    }
    generationTimeoutRef.current = window.setTimeout(() => setGenerating(false), 850);
  };

  const model = {
    activeChapter,
    completedChapterIds,
    generating,
    selectedFile,
    selectedFilePath,
    selectedFinding,
    selectedSignal,
    signals: ANALYSIS_SIGNALS,
    stale,
    viewedPaths,
    onChapterComplete: toggleChapterComplete,
    onRegenerate: regenerate,
    onSelectChapter: selectChapter,
    onSelectFile: selectFile,
    onSelectFinding: selectFinding,
    onSelectSignal: selectSignal,
    onToggleViewed: toggleViewed,
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <ReviewPrHeader
        detail={REVIEW_DETAIL}
        variant="compact"
        contentClassName="px-4 sm:px-5"
        reviewAction={<WalkthroughStatus generating={generating} stale={stale} />}
      />
      <AnalysisCommandBar
        completedCount={completedChapterIds.size}
        generating={generating}
        selectedSignal={selectedSignal}
        stale={stale}
        viewedCount={viewedPaths.size}
        onRegenerate={regenerate}
      />
      {props.variant === "rail" ? <RailVariant {...model} /> : null}
      {props.variant === "focus" ? <FocusVariant {...model} /> : null}
      {props.variant === "board" ? <BoardVariant {...model} /> : null}
      <PrototypeStateStrip
        activeChapter={activeChapter}
        completedCount={completedChapterIds.size}
        generating={generating}
        selectedFilePath={selectedFilePath}
        stale={stale}
        viewedCount={viewedPaths.size}
      />
      <PrototypeSwitcher current={props.variant} onVariantChange={props.onVariantChange} />
    </div>
  );
}

function WalkthroughStatus(props: { generating: boolean; stale: boolean }): ReactElement {
  if (props.generating) {
    return (
      <ReviewPill tone="info" icon={<Loader2Icon className="animate-spin" />}>
        Analyzing
      </ReviewPill>
    );
  }
  return (
    <ReviewPill tone={props.stale ? "warning" : "success"} icon={<BotIcon />}>
      {props.stale ? "Digest stale" : "Digest ready"}
    </ReviewPill>
  );
}

function AnalysisCommandBar(props: {
  completedCount: number;
  generating: boolean;
  selectedSignal: AnalysisSignal;
  stale: boolean;
  viewedCount: number;
  onRegenerate: () => void;
}): ReactElement {
  const failedChecks = CHECKS.filter((check) => check.state === "failure").length;
  const blockerCount = FINDINGS.filter((finding) => finding.severity === "blocker").length;
  const openSignals = ANALYSIS_SIGNALS.filter((signal) => signal.status !== "resolved").length;
  const coverage = `${props.viewedCount}/${CHANGED_FILES.length}`;
  return (
    <section className="shrink-0 border-b border-border/35 bg-[var(--color-background-surface)] px-4 py-3 sm:px-5">
      <div className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-start 2xl:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background text-foreground shadow-sm">
            <BotIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                Analysis command
              </h2>
              <ReviewPill tone={props.stale ? "warning" : "success"}>
                {props.stale ? "Needs refresh" : "Fresh"}
              </ReviewPill>
              <SignalKindPill kind={props.selectedSignal.kind} />
            </div>
            <p className="mt-1 max-w-4xl text-[12px] leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">{props.selectedSignal.title}</span>
              <span> · {props.selectedSignal.summary}</span>
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 2xl:justify-end">
          <AnalysisTab active label="Signals" value={String(openSignals)} />
          <AnalysisTab icon={<BugIcon />} label="Blockers" value={String(blockerCount)} tone="danger" />
          <AnalysisTab label="Checks" value={String(failedChecks)} tone="danger" />
          <AnalysisTab label="Viewed" value={coverage} />
          <AnalysisTab label="Sections" value={`${props.completedCount}/${CHAPTERS.length}`} />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 rounded-full px-3 text-[12px]"
            disabled={props.generating}
            onClick={props.onRegenerate}
          >
            {props.generating ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Re-run analysis
          </Button>
        </div>
      </div>
    </section>
  );
}

function AnalysisTab(props: {
  active?: boolean;
  icon?: ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "danger";
}): ReactElement {
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px]",
        props.active
          ? "border-foreground/20 bg-foreground text-background"
          : "border-border/35 bg-muted/12 text-muted-foreground",
      )}
    >
      {props.icon ? <span className="[&_svg]:size-3.5">{props.icon}</span> : null}
      <span className="whitespace-nowrap">{props.label}</span>
      <span
        className={cn(
          "font-mono font-semibold tabular-nums",
          props.active
            ? "text-background"
            : props.tone === "danger"
              ? "text-destructive"
              : "text-foreground",
        )}
      >
        {props.value}
      </span>
    </div>
  );
}

type PrototypeModel = {
  readonly activeChapter: WalkthroughChapter;
  readonly completedChapterIds: ReadonlySet<string>;
  readonly generating: boolean;
  readonly selectedFile: ReviewChangedFile | null;
  readonly selectedFilePath: string | null;
  readonly selectedFinding: ReviewFinding | null;
  readonly selectedSignal: AnalysisSignal;
  readonly signals: readonly AnalysisSignal[];
  readonly stale: boolean;
  readonly viewedPaths: ReadonlySet<string>;
  readonly onChapterComplete: (chapterId: string) => void;
  readonly onRegenerate: () => void;
  readonly onSelectChapter: (chapter: WalkthroughChapter) => void;
  readonly onSelectFile: (path: string) => void;
  readonly onSelectFinding: (finding: ReviewFinding) => void;
  readonly onSelectSignal: (signal: AnalysisSignal) => void;
  readonly onToggleViewed: (path: string) => void;
};

function RailVariant(props: PrototypeModel): ReactElement {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1.45fr)_minmax(18rem,23rem)] xl:overflow-hidden">
      <aside className="min-h-[18rem] border-b border-border/35 bg-[var(--color-background-surface)] xl:min-h-0 xl:border-b-0 xl:border-r">
        <SignalQueue {...props} title="Review desk" />
      </aside>
      <section className="min-h-[30rem] overflow-hidden xl:min-h-0">
        <EvidenceCanvas {...props} />
      </section>
      <aside className="min-h-[24rem] border-t border-border/35 bg-background xl:min-h-0 xl:border-l xl:border-t-0">
        <ResolutionStack {...props} />
      </aside>
    </main>
  );
}

function FocusVariant(props: PrototypeModel): ReactElement {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <CaseHero {...props} />
      <section className="grid min-h-[38rem] min-w-0 flex-1 grid-cols-1 overflow-hidden border-t border-border/35 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,26rem)]">
        <div className="min-h-[34rem] overflow-hidden bg-background xl:min-h-0">
          <EvidenceCanvas {...props} caseMode />
        </div>
        <aside className="min-h-[24rem] border-t border-border/35 bg-[var(--color-background-surface)] xl:min-h-0 xl:border-l xl:border-t-0">
          <ResolutionStack {...props} caseMode />
        </aside>
      </section>
      <ReadOrderStrip {...props} />
    </main>
  );
}

function SignalQueue(props: PrototypeModel & { title: string }): ReactElement {
  const openSignals = props.signals.filter((signal) => signal.status !== "resolved").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/35 px-3 py-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-foreground">{props.title}</h2>
            <p className="text-[11px] text-muted-foreground">Ranked review signals</p>
          </div>
          <ReviewPill tone="danger">{openSignals} open</ReviewPill>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {props.signals.map((signal) => {
          const active = signal.id === props.selectedSignal.id;
          const kind = signalKindMeta(signal.kind);
          return (
            <button
              key={signal.id}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => props.onSelectSignal(signal)}
              className={cn(
                "rounded-lg border p-3 text-left outline-none",
                "transition-[background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-foreground/25 bg-background"
                  : "border-border/35 bg-background/55 hover:bg-background",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                    kind.iconClassName,
                  )}
                  aria-hidden="true"
                >
                  {kind.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ReviewPill tone={kind.tone}>{kind.label}</ReviewPill>
                    <SeverityPill severity={signal.priority} />
                  </span>
                  <span className="mt-2 block text-[12px] font-semibold leading-4 text-foreground">
                    {signal.title}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {signal.summary}
                  </span>
                  <span className="mt-2 flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {signal.file ?? signal.evidence}
                    </span>
                    {signal.line !== null ? (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        L{signal.line}
                      </span>
                    ) : null}
                  </span>
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CaseHero(props: PrototypeModel): ReactElement {
  const kind = signalKindMeta(props.selectedSignal.kind);
  return (
    <section className="shrink-0 bg-background px-4 py-4 sm:px-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <div className="min-w-0 rounded-lg border border-border/35 bg-[var(--color-background-surface)] p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <ReviewPill tone={kind.tone} icon={kind.icon}>
              {kind.label}
            </ReviewPill>
            <SeverityPill severity={props.selectedSignal.priority} />
            <ReviewPill tone={props.stale ? "warning" : "success"}>
              {props.stale ? "stale analysis" : "fresh analysis"}
            </ReviewPill>
          </div>
          <h2 className="mt-3 text-[22px] font-semibold leading-7 text-foreground">
            {props.selectedSignal.title}
          </h2>
          <p className="mt-2 max-w-4xl text-[13px] leading-6 text-muted-foreground">
            {props.selectedSignal.summary}
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <CaseMetric label="Evidence" value={props.selectedSignal.evidence} />
            <CaseMetric label="Owner" value="Reviewer" />
            <CaseMetric label="State" value={props.selectedSignal.status} />
          </div>
        </div>
        <div className="rounded-lg border border-border/35 bg-[var(--color-background-surface)] p-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Next action</div>
          <p className="mt-2 text-[13px] leading-5 text-foreground">{props.selectedSignal.action}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="prominent" className="px-3 text-[12px]">
              Comment
            </Button>
            <Button size="sm" variant="outline" className="rounded-full px-3 text-[12px]">
              Ask
            </Button>
            <Button size="sm" variant="ghost" className="rounded-full px-3 text-[12px]">
              Dismiss
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3 w-full rounded-full px-3 text-[12px]"
            onClick={() => props.onChapterComplete(props.activeChapter.id)}
          >
            <CheckIcon className="size-3.5" />
            Mark reviewed
          </Button>
        </div>
      </div>
    </section>
  );
}

function CaseMetric(props: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-md border border-border/30 bg-background px-3 py-2">
      <div className="text-[10px] font-medium text-muted-foreground">{props.label}</div>
      <div className="mt-1 truncate text-[12px] font-medium text-foreground">{props.value}</div>
    </div>
  );
}

function EvidenceCanvas(props: PrototypeModel & { caseMode?: boolean }): ReactElement {
  const signalFile = props.selectedSignal.file;
  const files = signalFile !== null ? [signalFile] : props.activeChapter.files;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/35 px-3 py-3">
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-foreground">Evidence canvas</h3>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {props.selectedSignal.evidence}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {files.map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => props.onSelectFile(file)}
                className="max-w-64 truncate rounded-full border border-border/35 bg-muted/18 px-2.5 py-1 font-mono text-[10px] text-foreground outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {file}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
        <div className="min-h-[24rem] overflow-hidden xl:min-h-0">
          <DiffWorkspace {...props} compact={props.caseMode} hideFileTree={props.caseMode} />
        </div>
        <aside className="border-t border-border/35 bg-[var(--color-background-surface)] p-3 xl:border-l xl:border-t-0">
          <EvidenceNotes {...props} />
        </aside>
      </div>
    </div>
  );
}

function EvidenceNotes(props: PrototypeModel): ReactElement {
  return (
    <div className="space-y-3">
      <EvidenceSection title="Why it matters" icon={<InfoIcon className="size-3.5" />}>
        <p className="text-[12px] leading-5 text-foreground">{props.activeChapter.intent}</p>
      </EvidenceSection>
      <EvidenceSection title="Judgment call" icon={<MessageCircleIcon className="size-3.5" />}>
        <p className="text-[12px] leading-5 text-foreground">{props.activeChapter.question}</p>
      </EvidenceSection>
      <EvidenceSection title="Patch anchor" icon={<DiffIcon className="size-3.5" />}>
        <p className="truncate font-mono text-[11px] text-foreground">{props.activeChapter.hunk}</p>
      </EvidenceSection>
    </div>
  );
}

function ResolutionStack(props: PrototypeModel & { caseMode?: boolean }): ReactElement {
  const finding = props.selectedFinding;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/35 px-3 py-3">
        <h3 className="text-[13px] font-semibold text-foreground">Resolution</h3>
        <p className="text-[11px] text-muted-foreground">Decision, comment, or follow-up.</p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <EvidenceSection title="Recommended move" icon={<CheckIcon className="size-3.5" />}>
          <p className="text-[12px] leading-5 text-foreground">{props.selectedSignal.action}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button size="xs" variant="prominent" className="h-6 px-2 text-[11px]">
              Comment
            </Button>
            <Button size="xs" variant="outline" className="h-6 rounded-full px-2 text-[11px]">
              Ask
            </Button>
            <Button size="xs" variant="ghost" className="h-6 rounded-full px-2 text-[11px]">
              Dismiss
            </Button>
          </div>
        </EvidenceSection>
        {finding ? <FindingCard finding={finding} onSelectFile={props.onSelectFile} /> : null}
        <EvidenceSection title="Affected files" icon={<DiffIcon className="size-3.5" />}>
          <div className="flex flex-col gap-1.5">
            {props.activeChapter.files.map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => props.onSelectFile(file)}
                className="truncate rounded-md bg-muted/25 px-2 py-1 text-left font-mono text-[11px] text-foreground outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {file}
              </button>
            ))}
          </div>
        </EvidenceSection>
        {props.caseMode ? <RunAndChecksPanel /> : null}
        <Button
          size="sm"
          variant="outline"
          className="w-full rounded-full px-3 text-[12px]"
          onClick={props.onRegenerate}
        >
          <RefreshCwIcon className="size-3.5" />
          Re-run analysis
        </Button>
      </div>
    </div>
  );
}

function ReadOrderStrip(props: PrototypeModel): ReactElement {
  return (
    <nav
      aria-label="Review read order"
      className="shrink-0 overflow-x-auto border-t border-border/35 bg-[var(--color-background-surface)] px-3 py-2"
    >
      <ol className="flex min-w-max items-center gap-2">
        {CHAPTERS.map((chapter, index) => {
          const active = chapter.id === props.activeChapter.id;
          return (
            <li key={chapter.id}>
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                onClick={() => props.onSelectChapter(chapter)}
                className={cn(
                  "flex min-w-56 items-center gap-2 rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-foreground/25 bg-background"
                    : "border-border/35 bg-background/55 hover:bg-background",
                )}
              >
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium text-foreground">
                    {chapter.title}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {chapter.anchor}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SignalMatrix(props: PrototypeModel): ReactElement {
  const groups: ReadonlyArray<{ title: string; signals: readonly AnalysisSignal[] }> = [
    {
      title: "Blockers",
      signals: props.signals.filter((signal) => signal.priority === "blocker"),
    },
    {
      title: "Questions",
      signals: props.signals.filter((signal) => signal.kind === "question"),
    },
    {
      title: "Checks",
      signals: props.signals.filter((signal) => signal.kind === "check"),
    },
    {
      title: "Coverage",
      signals: props.signals.filter((signal) => signal.kind === "coverage" || signal.priority === "minor"),
    },
  ];

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-3">
      {groups.map((group) => (
        <SignalMatrixGroup
          key={group.title}
          activeSignalId={props.selectedSignal.id}
          group={group}
          onSelectSignal={props.onSelectSignal}
        />
      ))}
    </div>
  );
}

function SignalMatrixGroup(props: {
  activeSignalId: string;
  group: { title: string; signals: readonly AnalysisSignal[] };
  onSelectSignal: (signal: AnalysisSignal) => void;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-lg border border-border/35 bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-3 py-2">
        <h3 className="text-[12px] font-semibold text-foreground">{props.group.title}</h3>
        <ReviewPill tone="muted">{props.group.signals.length}</ReviewPill>
      </div>
      <div className="divide-y divide-border/25">
        {props.group.signals.length > 0 ? (
          props.group.signals.map((signal) => (
            <SignalMatrixRow
              key={signal.id}
              active={signal.id === props.activeSignalId}
              signal={signal}
              onSelectSignal={props.onSelectSignal}
            />
          ))
        ) : (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">No signals</div>
        )}
      </div>
    </section>
  );
}

function SignalMatrixRow(props: {
  active: boolean;
  signal: AnalysisSignal;
  onSelectSignal: (signal: AnalysisSignal) => void;
}): ReactElement {
  const kind = signalKindMeta(props.signal.kind);
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={() => props.onSelectSignal(props.signal)}
      className={cn(
        "grid w-full min-w-0 grid-cols-1 gap-3 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[9rem_minmax(0,1fr)_12rem_9rem]",
        props.active ? "bg-muted/45" : "hover:bg-muted/20",
      )}
    >
      <span className="flex items-center gap-1.5">
        <ReviewPill tone={kind.tone} icon={kind.icon}>{kind.label}</ReviewPill>
        <SeverityPill severity={props.signal.priority} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold text-foreground">
          {props.signal.title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {props.signal.summary}
        </span>
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        {props.signal.file ?? props.signal.evidence}
      </span>
      <span className="text-[11px] text-foreground">{props.signal.action}</span>
    </button>
  );
}

function BoardVariant(props: PrototypeModel): ReactElement {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-background-surface)] p-3 sm:p-4">
      <SignalMatrix {...props} />
    </main>
  );
}

function findingsForChapter(chapter: WalkthroughChapter): readonly ReviewFinding[] {
  return FINDINGS.filter((finding) => chapter.files.includes(finding.file));
}

function buildAnalysisSignals(): readonly AnalysisSignal[] {
  const findingSignals = FINDINGS.map((finding): AnalysisSignal => {
    const chapter = CHAPTERS.find((candidate) => candidate.files.includes(finding.file)) ?? null;
    return {
      id: signalIdForFinding(finding),
      kind: "finding",
      priority: finding.severity,
      title: finding.title,
      summary: finding.summary,
      evidence: `${finding.file}:L${finding.line}`,
      action: finding.suggestedFix,
      status: findingStatusToSignalStatus(finding.status),
      findingId: finding.id,
      chapterId: chapter?.id ?? null,
      file: finding.file,
      line: finding.line,
    };
  });

  const checkSignals = CHECKS.filter((check) => check.state !== "success").map(
    (check): AnalysisSignal => ({
      id: `check:${check.name}`,
      kind: "check",
      priority: check.state === "failure" ? "blocker" : "minor",
      title: `${check.name} needs attention`,
      summary: check.description ?? "The run has not produced a passing result yet.",
      evidence: "CI status",
      action: check.state === "failure" ? "Inspect the failed lane" : "Wait for the run",
      status: check.state === "pending" ? "waiting" : "open",
      findingId: null,
      chapterId: "proof",
      file: null,
      line: null,
    }),
  );

  const questionSignals = CHAPTERS.filter((chapter) => chapter.status !== "done").map(
    (chapter): AnalysisSignal => ({
      id: signalIdForChapter(chapter),
      kind: "question",
      priority: chapter.risk,
      title: chapter.question,
      summary: chapter.summary,
      evidence: chapter.anchor,
      action: "Decide before approval",
      status: chapter.status === "queued" ? "waiting" : "open",
      findingId: null,
      chapterId: chapter.id,
      file: chapter.files[0] ?? null,
      line: null,
    }),
  );

  const coverageSignal: AnalysisSignal = {
    id: "coverage:changed-files",
    kind: "coverage",
    priority: "minor",
    title: "Changed-file coverage is partial",
    summary: "The digest should make it obvious which files have not been inspected yet.",
    evidence: `${CHANGED_FILES.length} files in patch`,
    action: "Open the remaining files",
    status: "waiting",
    findingId: null,
    chapterId: "proof",
    file: CHANGED_FILES[CHANGED_FILES.length - 1]?.path ?? null,
    line: null,
  };

  return [...findingSignals, ...checkSignals, ...questionSignals, coverageSignal].sort(
    compareAnalysisSignals,
  );
}

function compareAnalysisSignals(left: AnalysisSignal, right: AnalysisSignal): number {
  const severityDelta = signalPriorityRank(left.priority) - signalPriorityRank(right.priority);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  return signalKindRank(left.kind) - signalKindRank(right.kind);
}

function signalPriorityRank(priority: ReviewFindingSeverity): number {
  if (priority === "blocker") {
    return 0;
  }
  if (priority === "major") {
    return 1;
  }
  return 2;
}

function signalKindRank(kind: AnalysisSignalKind): number {
  if (kind === "finding") {
    return 0;
  }
  if (kind === "check") {
    return 1;
  }
  if (kind === "question") {
    return 2;
  }
  return 3;
}

function findingStatusToSignalStatus(status: ReviewFinding["status"]): AnalysisSignal["status"] {
  if (status === "resolved") {
    return "resolved";
  }
  if (status === "queued") {
    return "waiting";
  }
  return "open";
}

function signalIdForFinding(finding: ReviewFinding): string {
  return `finding:${finding.id}`;
}

function signalIdForChapter(chapter: WalkthroughChapter): string {
  return `question:${chapter.id}`;
}

function SignalKindPill(props: { kind: AnalysisSignalKind }): ReactElement {
  const meta = signalKindMeta(props.kind);
  return (
    <ReviewPill tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </ReviewPill>
  );
}

function signalKindMeta(kind: AnalysisSignalKind): {
  label: string;
  tone: "danger" | "warning" | "info" | "muted";
  icon: ReactNode;
  iconClassName: string;
} {
  if (kind === "finding") {
    return {
      label: "Finding",
      tone: "danger",
      icon: <BugIcon className="size-3.5" />,
      iconClassName: "bg-destructive/12 text-destructive",
    };
  }
  if (kind === "check") {
    return {
      label: "Check",
      tone: "warning",
      icon: <ClockIcon className="size-3.5" />,
      iconClassName: "bg-warning/12 text-warning-foreground",
    };
  }
  if (kind === "question") {
    return {
      label: "Question",
      tone: "info",
      icon: <MessageCircleIcon className="size-3.5" />,
      iconClassName: "bg-info/12 text-info-foreground",
    };
  }
  return {
    label: "Coverage",
    tone: "muted",
    icon: <GitPullRequestIcon className="size-3.5" />,
    iconClassName: "bg-muted text-muted-foreground",
  };
}

function DiffWorkspace(props: PrototypeModel & { compact?: boolean; hideFileTree?: boolean }): ReactElement {
  const selectedFile = props.selectedFile;
  const filesForChapter = new Set(props.activeChapter.files);
  const filteredFiles = props.compact
    ? CHANGED_FILES.filter((file) => filesForChapter.has(file.path))
    : CHANGED_FILES;
  const selectedFinding = props.selectedFinding;

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-background">
      <aside
        className={cn(
          "hidden min-h-0 w-72 shrink-0 flex-col border-r border-border/35 lg:flex",
          props.hideFileTree && "lg:hidden",
        )}
      >
        <div className="border-b border-border/25 px-3 py-2.5">
          <h3 className="text-[12px] font-semibold text-foreground">Changed files</h3>
          <p className="text-[11px] text-muted-foreground">
            {props.viewedPaths.size}/{CHANGED_FILES.length} viewed
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReviewFileTree
            files={filteredFiles}
            isLoading={false}
            selectedFilePath={props.selectedFilePath}
            viewedPaths={props.viewedPaths}
            onSelectFile={props.onSelectFile}
            onToggleViewed={props.onToggleViewed}
          />
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/35 px-3">
          <DiffIcon className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
            {selectedFile?.path ?? "Select a file"}
          </span>
          {selectedFile ? (
            <DiffStat
              additions={selectedFile.insertions}
              deletions={selectedFile.deletions}
              className="text-[11px]"
            />
          ) : null}
        </div>
        {selectedFinding ? <DiffFindingBanner finding={selectedFinding} /> : null}
        <DiffPreview chapter={props.activeChapter} file={selectedFile} />
      </section>
    </div>
  );
}

function DiffFindingBanner(props: { finding: ReviewFinding }): ReactElement {
  const category = findingCategoryMeta(props.finding.category);
  return (
    <div className="shrink-0 border-b border-border/30 bg-muted/10 px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ReviewPill tone={category.tone} icon={category.icon}>
              {category.label}
            </ReviewPill>
            <SeverityPill severity={props.finding.severity} />
            <span className="font-mono text-[10px] text-muted-foreground">
              {props.finding.file}:L{props.finding.line}
            </span>
          </div>
          <p className="mt-1 text-[12px] font-medium leading-4 text-foreground">
            {props.finding.title}
          </p>
        </div>
        <p className="max-w-xl text-[11px] leading-4 text-muted-foreground">
          {props.finding.suggestedFix}
        </p>
      </div>
    </div>
  );
}

function DiffPreview(props: {
  chapter: WalkthroughChapter;
  file: ReviewChangedFile | null;
}): ReactElement {
  const fileName = props.file?.path ?? props.chapter.files[0] ?? "apps/web/src/components/review";
  const lines = useMemo(
    () => [
      `diff --git a/${fileName} b/${fileName}`,
      props.chapter.hunk,
      "  const sourceKey = reviewSourceKey(source);",
      "+ const walkthroughKey = buildWalkthroughKey({ sourceKey, headSha, patchSignature });",
      "+ const activeChapter = walkthrough.chapters.find((chapter) => chapter.id === selectedId);",
      "- const reviewMode = tab === \"files\" ? \"files\" : \"conversation\";",
      "+ const reviewMode = tab === \"walkthrough\" ? \"walkthrough\" : tab;",
      "  return <ReviewSurface selectedFilePath={selectedFilePath} />;",
    ],
    [fileName, props.chapter.hunk],
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-background-surface)] p-4">
      <div className="overflow-hidden rounded-lg border border-border/35 bg-background font-mono text-[12px] shadow-sm">
        {lines.map((line, index) => {
          const added = line.startsWith("+");
          const removed = line.startsWith("-");
          return (
            <div
              key={`${line}-${String(index)}`}
              className={cn(
                "grid min-h-7 grid-cols-[3rem_minmax(0,1fr)] border-b border-border/20 last:border-b-0",
                added && "bg-success/8",
                removed && "bg-destructive/8",
                line.startsWith("@@") && "bg-muted/35 text-muted-foreground",
              )}
            >
              <span className="border-r border-border/20 px-2 py-1 text-right text-[10px] text-muted-foreground tabular-nums">
                {index + 41}
              </span>
              <code className="min-w-0 overflow-x-auto px-3 py-1 text-foreground">{line}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunAndChecksPanel(): ReactElement {
  return (
    <EvidenceSection title="Checks and run" icon={<ClockIcon className="size-3.5" />}>
      <div className="space-y-3">
        <div className="space-y-2">
          {CHECKS.map((check) => (
            <div key={check.name} className="flex min-w-0 items-center gap-2">
              <CheckStateIcon state={check.state} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                {check.name}
              </span>
            </div>
          ))}
        </div>
        <div className="border-t border-border/30 pt-3">
          <div className="space-y-2.5">
            {RUN_STEPS.map((step) => (
              <div key={step.label} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2">
                <CheckStateIcon state={runStepCheckState(step.state)} className="mt-0.5" />
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {step.label}
                  </div>
                  <p className="text-[11px] leading-4 text-muted-foreground">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </EvidenceSection>
  );
}

function FindingCard(props: {
  finding: ReviewFinding;
  onSelectFile: (path: string) => void;
}): ReactElement {
  const category = findingCategoryMeta(props.finding.category);
  return (
    <article className="rounded-lg border border-border/45 bg-background p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
            category.iconClassName,
          )}
          aria-hidden="true"
        >
          {category.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ReviewPill tone={category.tone}>{category.label}</ReviewPill>
            <SeverityPill severity={props.finding.severity} />
            <ReviewPill tone={props.finding.status === "open" ? "warning" : "muted"}>
              {props.finding.status}
            </ReviewPill>
          </div>
          <h4 className="mt-2 text-[12px] font-semibold leading-4 text-foreground">
            {props.finding.title}
          </h4>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {props.finding.summary}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => props.onSelectFile(props.finding.file)}
        className="mt-3 flex min-w-0 max-w-full items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-left outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {props.finding.file}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          L{props.finding.line}
        </span>
      </button>
      <div className="mt-2 rounded-md bg-muted/18 px-2 py-2">
        <div className="text-[10px] font-medium text-muted-foreground">Suggested fix</div>
        <p className="mt-1 text-[11px] leading-4 text-foreground">{props.finding.suggestedFix}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" className="h-6 rounded-full px-2 text-[11px]">
          Comment
        </Button>
        <Button size="xs" variant="outline" className="h-6 rounded-full px-2 text-[11px]">
          Ask
        </Button>
        <Button size="xs" variant="ghost" className="h-6 rounded-full px-2 text-[11px]">
          Dismiss
        </Button>
      </div>
    </article>
  );
}

function findingCategoryMeta(category: ReviewFinding["category"]): {
  label: string;
  tone: "danger" | "warning" | "info";
  icon: ReactNode;
  iconClassName: string;
} {
  if (category === "bug") {
    return {
      label: "Bug",
      tone: "danger",
      icon: <BugIcon className="size-3.5" />,
      iconClassName: "bg-destructive/12 text-destructive",
    };
  }
  if (category === "security") {
    return {
      label: "Security",
      tone: "warning",
      icon: <TriangleAlertIcon className="size-3.5" />,
      iconClassName: "bg-warning/12 text-warning-foreground",
    };
  }
  return {
    label: "Flag",
    tone: "info",
    icon: <CircleAlertIcon className="size-3.5" />,
    iconClassName: "bg-info/12 text-info-foreground",
  };
}

function runStepCheckState(state: RunStep["state"]): ReviewCheck["state"] {
  if (state === "success") {
    return "success";
  }
  if (state === "failure") {
    return "failure";
  }
  return "pending";
}

function EvidenceSection(props: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-lg border border-border/35 bg-muted/12 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        {props.icon}
        {props.title}
      </div>
      {props.children}
    </section>
  );
}

function SeverityPill(props: { severity: ReviewFindingSeverity }): ReactElement {
  const descriptor = severityPill(props.severity);
  return <ReviewPill tone={descriptor.tone}>{descriptor.label}</ReviewPill>;
}

function PrototypeStateStrip(props: {
  activeChapter: WalkthroughChapter;
  completedCount: number;
  generating: boolean;
  selectedFilePath: string | null;
  stale: boolean;
  viewedCount: number;
}): ReactElement {
  return (
    <div className="hidden shrink-0 items-center gap-2 border-t border-border/35 bg-muted/18 px-3 py-1.5 text-[11px] text-muted-foreground xl:flex">
      <Badge variant="outline">Prototype state</Badge>
      <span>chapter: {props.activeChapter.id}</span>
      <span>completed: {props.completedCount}/{CHAPTERS.length}</span>
      <span>viewed files: {props.viewedCount}/{CHANGED_FILES.length}</span>
      <span className="min-w-0 flex-1 truncate">selected: {props.selectedFilePath ?? "none"}</span>
      <span>{props.generating ? "generating" : props.stale ? "stale" : "fresh"}</span>
      <span className="ms-auto flex items-center gap-1">
        <GitCommitIcon className="size-3" />
        9f4c2ad
      </span>
      <LabelPill name="review-surface" color="60a5fa" />
    </div>
  );
}

function PrototypeSwitcher(props: {
  current: WalkthroughPrototypeVariant;
  onVariantChange: (variant: WalkthroughPrototypeVariant) => void;
}): ReactElement | null {
  const { current, onVariantChange } = props;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (!canUseVariantArrowShortcut(event.target)) {
        return;
      }
      event.preventDefault();
      onVariantChange(nextVariant(current, event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [current, onVariantChange]);

  if (import.meta.env.PROD) {
    return null;
  }

  const currentVariant = WALKTHROUGH_PROTOTYPE_VARIANTS.find(
    (variant) => variant.id === current,
  )!;

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/55 bg-background/95 px-2 py-1.5 shadow-xl backdrop-blur">
      <Button
        size="icon-xs"
        variant="chrome-outline"
        aria-label="Previous prototype variant"
        onClick={() => onVariantChange(nextVariant(current, -1))}
      >
        <ArrowLeftIcon className="size-3.5" />
      </Button>
      <div className="min-w-44 text-center text-[11px]">
        <span className="font-semibold text-foreground">{currentVariant.label}</span>
        <span className="text-muted-foreground"> · PR walkthrough prototype</span>
      </div>
      <Button
        size="icon-xs"
        variant="chrome-outline"
        aria-label="Next prototype variant"
        onClick={() => onVariantChange(nextVariant(current, 1))}
      >
        <ArrowRightIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function canUseVariantArrowShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  if (target === document.body) {
    return true;
  }
  return (
    target.closest(
      'a, button, input, textarea, select, [contenteditable="true"], [role="button"], [role="tree"], [role="treeitem"]',
    ) === null
  );
}

function nextVariant(
  current: WalkthroughPrototypeVariant,
  direction: 1 | -1,
): WalkthroughPrototypeVariant {
  const index = WALKTHROUGH_PROTOTYPE_VARIANTS.findIndex((variant) => variant.id === current);
  const nextIndex =
    (index + direction + WALKTHROUGH_PROTOTYPE_VARIANTS.length) %
    WALKTHROUGH_PROTOTYPE_VARIANTS.length;
  return WALKTHROUGH_PROTOTYPE_VARIANTS[nextIndex]!.id;
}
