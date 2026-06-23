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
  AdjustmentsIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  BugIcon,
  ChartBarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  ClockIcon,
  CircleAlertIcon,
  ComposerSendArrowIcon,
  CopyIcon,
  DiffIcon,
  EllipsisIcon,
  EyeIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InfoIcon,
  ListChecksIcon,
  Loader2Icon,
  LockIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { CheckStateIcon, LabelPill } from "./reviewPrPrimitives";
import { ReviewFileTree } from "./ReviewFileTree";
import { ReviewPrHeader } from "./ReviewPrHeader";
import { ReviewPill, severityPill } from "./reviewPrimitives";

export type WalkthroughPrototypeVariant = "stage" | "rail" | "focus" | "board";

export const WALKTHROUGH_PROTOTYPE_VARIANTS: ReadonlyArray<{
  id: WalkthroughPrototypeVariant;
  label: string;
}> = [
  { id: "stage", label: "Stage" },
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
  readonly confidence: number;
}

type FocusAreaType =
  | "security"
  | "breaking-change"
  | "high-complexity"
  | "data-integrity"
  | "new-pattern"
  | "architecture"
  | "performance"
  | "testing-gap";

type FocusAreaSeverity = "critical" | "high" | "medium" | "info";

type ComplexityLevel = "low" | "medium" | "high" | "very-high";

interface PrologueKeyChange {
  readonly summary: string;
  readonly description: string;
}

interface PrologueFocusArea {
  readonly type: FocusAreaType;
  readonly severity: FocusAreaSeverity;
  readonly title: string;
  readonly description: string;
  readonly locations: readonly string[];
}

interface ProloguePlan {
  readonly motivation: string;
  readonly outcome: string;
  readonly keyChanges: readonly PrologueKeyChange[];
  readonly focusAreas: readonly PrologueFocusArea[];
  readonly complexity: { readonly level: ComplexityLevel; readonly reasoning: string };
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
    confidence: 0.92,
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
    confidence: 0.78,
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
    confidence: 0.64,
  },
];

const PROLOGUE: ProloguePlan = {
  motivation:
    "Reviewing a big PR meant reading files in whatever order GitHub listed them, so the reasoning behind the change kept getting lost.",
  outcome:
    "Reviewers now get a guided, chapter-by-chapter tour with the judgment calls surfaced up front instead of buried in the diff.",
  keyChanges: [
    {
      summary: "Walkthroughs are now a durable artifact",
      description: "A schema plus query key make the overview cacheable and safe to rerun.",
    },
    {
      summary: "Hunks cluster into causal reading order",
      description: "Server parsing groups related changes into chapters with stable anchors.",
    },
    {
      summary: "Guided mode rides alongside Files",
      description: "The PR view gains a walkthrough layer without touching diff hydration.",
    },
    {
      summary: "Open latency is held to a number",
      description: "Browser coverage keeps generation explicit and measurable.",
    },
  ],
  focusAreas: [
    {
      type: "data-integrity",
      severity: "high",
      title: "Walkthrough freshness",
      description:
        "A new push must invalidate the cached overview; confirm the key carries enough freshness metadata.",
      locations: ["apps/web/src/lib/reviewReactQuery.ts"],
    },
    {
      type: "architecture",
      severity: "medium",
      title: "Guided mode vs Files ownership",
      description:
        "Decide whether Walkthrough is a primary tab or a persistent rail while Files stays the source of truth.",
      locations: ["apps/web/src/components/review/ReviewPrView.tsx"],
    },
    {
      type: "performance",
      severity: "info",
      title: "Open latency budget",
      description:
        "Verify walkthrough-open timing is tracked separately from default PR hydration.",
      locations: ["apps/web/src/components/review/ReviewPrView.performance.browser.tsx"],
    },
  ],
  complexity: {
    level: "high",
    reasoning: "New contract plus server parsing plus a parallel review surface across four files.",
  },
};

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
  {
    path: "apps/web/src/components/review/ReviewPrView.performance.browser.tsx",
    insertions: 28,
    deletions: 50,
  },
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
    summary:
      "Server parsing turns raw unified diff hunks into chapter candidates with stable anchors.",
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
    summary:
      "The PR view gets a walkthrough mode without changing the existing Files hydration path.",
    intent: "Keep Files as the source of truth while adding a guided overview layer.",
    anchor: "review route + panel",
    risk: "major",
    files: [
      "apps/web/src/components/review/ReviewPrView.tsx",
      "apps/web/src/components/review/ReviewWalkthroughPanel.tsx",
    ],
    hunk: '@@ -102,7 +124,18 @@ type PrTab = "conversation" | "files" | "commits";',
    question: "Is Walkthrough a primary tab or a persistent rail while Files stays open?",
    status: "queued",
  },
  {
    id: "proof",
    title: "Protect the performance path",
    summary:
      "Browser coverage keeps walkthrough generation explicit and prevents eager diff hydration.",
    intent: "Make the new overview measurable without slowing the default PR route.",
    anchor: "browser coverage",
    risk: "minor",
    files: ["apps/web/src/components/review/ReviewPrView.performance.browser.tsx"],
    hunk: "@@ -321,6 +366,28 @@ expect(nativeApiMock.loadPullRequestSurface)",
    question:
      "Should the benchmark track walkthrough open latency separately from PR view latency?",
    status: "queued",
  },
];

const ANALYSIS_SIGNALS: readonly AnalysisSignal[] = buildAnalysisSignals();

export function ReviewWalkthroughPrototype(props: {
  variant: WalkthroughPrototypeVariant;
  onVariantChange: (variant: WalkthroughPrototypeVariant) => void;
}): ReactElement {
  const initialSignal =
    ANALYSIS_SIGNALS.find((signal) => signal.findingId === "finding-cache") ?? ANALYSIS_SIGNALS[0]!;
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

  const activeChapter = CHAPTERS.find((chapter) => chapter.id === activeChapterId) ?? CHAPTERS[0]!;
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
    setSelectedSignalId(
      firstFinding ? signalIdForFinding(firstFinding) : signalIdForChapter(chapter),
    );
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
      {props.variant === "stage" ? <StageVariant {...model} /> : null}
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
      {props.stale ? "Analysis stale" : "Analysis ready"}
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
          <AnalysisTab
            icon={<BugIcon />}
            label="Blockers"
            value={String(blockerCount)}
            tone="danger"
          />
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
          <p className="mt-2 text-[13px] leading-5 text-foreground">
            {props.selectedSignal.action}
          </p>
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
          <DiffWorkspace
            {...props}
            compact={props.caseMode ?? false}
            hideFileTree={props.caseMode ?? false}
          />
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
      signals: props.signals.filter(
        (signal) => signal.kind === "coverage" || signal.priority === "minor",
      ),
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
        <ReviewPill tone={kind.tone} icon={kind.icon}>
          {kind.label}
        </ReviewPill>
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

type StageReading = string;

type StageRightTab = "analysis" | "info";

type DiffRowKind = "context" | "add" | "del" | "mod";

interface DiffRow {
  readonly kind: DiffRowKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly oldText: string | null;
  readonly newText: string | null;
}

interface ChapterDiff {
  readonly hunkHeader: string;
  readonly contextAbove: number;
  readonly contextBelow: number;
  readonly totalLines: number;
  readonly rows: readonly DiffRow[];
}

function splitFilePath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return { name: path, dir: "" };
  }
  return { name: path.slice(index + 1), dir: path.slice(0, index) };
}

function chapterDiffStat(chapter: WalkthroughChapter): { additions: number; deletions: number } {
  return chapter.files.reduce(
    (totals, path) => {
      const file = CHANGED_FILES.find((candidate) => candidate.path === path);
      return {
        additions: totals.additions + (file?.insertions ?? 0),
        deletions: totals.deletions + (file?.deletions ?? 0),
      };
    },
    { additions: 0, deletions: 0 },
  );
}

function buildChapterDiff(chapter: WalkthroughChapter): ChapterDiff {
  const base = 1156 + CHAPTERS.indexOf(chapter) * 24;
  const rows: DiffRow[] = [
    {
      kind: "context",
      oldNo: base,
      newNo: base,
      oldText: "  const sourceKey = reviewSourceKey(source);",
      newText: "  const sourceKey = reviewSourceKey(source);",
    },
    {
      kind: "context",
      oldNo: base + 1,
      newNo: base + 1,
      oldText: "  const headSha = source.headSha;",
      newText: "  const headSha = source.headSha;",
    },
    {
      kind: "mod",
      oldNo: base + 2,
      newNo: base + 2,
      oldText: "  const cacheKey = buildKey({ sourceKey });",
      newText: "  const cacheKey = buildKey({ sourceKey, headSha, patchSignature });",
    },
    {
      kind: "del",
      oldNo: base + 3,
      newNo: null,
      oldText: '  const reviewMode = tab === "files" ? "files" : "conversation";',
      newText: null,
    },
    {
      kind: "add",
      oldNo: null,
      newNo: base + 3,
      oldText: null,
      newText: '  const reviewMode = tab === "walkthrough" ? "walkthrough" : tab;',
    },
    {
      kind: "context",
      oldNo: base + 4,
      newNo: base + 4,
      oldText: "  return <ReviewSurface mode={reviewMode} />;",
      newText: "  return <ReviewSurface mode={reviewMode} />;",
    },
  ];
  return {
    hunkHeader: chapter.hunk,
    contextAbove: 5,
    contextBelow: 5,
    totalLines: 40,
    rows,
  };
}

function StageVariant(props: PrototypeModel): ReactElement {
  const [reading, setReading] = useState<StageReading>("overview");
  const [rightTab, setRightTab] = useState<StageRightTab>("analysis");
  const [splitView, setSplitView] = useState(true);

  const activeChapter =
    reading === "overview" ? null : (CHAPTERS.find((chapter) => chapter.id === reading) ?? null);

  const openChapter = (chapter: WalkthroughChapter): void => {
    setReading(chapter.id);
    props.onSelectChapter(chapter);
  };

  const openReading = (next: StageReading): void => {
    if (next === "overview") {
      setReading("overview");
      return;
    }
    const chapter = CHAPTERS.find((candidate) => candidate.id === next);
    if (chapter) {
      openChapter(chapter);
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
      <StageControls
        rightTab={rightTab}
        splitView={splitView}
        onToggleSplit={() => setSplitView((value) => !value)}
        onSelectTab={setRightTab}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:overflow-hidden">
        <section className="order-2 min-h-0 overflow-y-auto bg-background xl:order-1">
          {activeChapter ? (
            <DevinChapterReader
              chapter={activeChapter}
              completed={props.completedChapterIds.has(activeChapter.id)}
              splitView={splitView}
              viewedPaths={props.viewedPaths}
              onChapterComplete={props.onChapterComplete}
              onToggleViewed={props.onToggleViewed}
              onSelectFinding={props.onSelectFinding}
              onSelectFile={props.onSelectFile}
              onNavigate={openReading}
            />
          ) : (
            <ProloguePanel onStart={openReading} />
          )}
        </section>
        <aside className="order-1 max-h-[42vh] overflow-y-auto border-b border-border/35 bg-[var(--color-background-surface)] xl:order-2 xl:max-h-none xl:overflow-visible xl:border-b-0 xl:border-l">
          {rightTab === "analysis" ? (
            <ChangesInPrRail
              reading={reading}
              viewedPaths={props.viewedPaths}
              onOpenOverview={() => setReading("overview")}
              onOpenChapter={openChapter}
            />
          ) : (
            <PrInfoPanel />
          )}
        </aside>
      </div>
      <AskBar />
    </main>
  );
}

function StageControls(props: {
  rightTab: StageRightTab;
  splitView: boolean;
  onToggleSplit: () => void;
  onSelectTab: (tab: StageRightTab) => void;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/35 bg-[var(--color-background-surface)] px-4 py-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={props.onToggleSplit}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/45 bg-background px-2.5 text-[12px] text-foreground outline-none transition-[background-color] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {props.splitView ? "Split view" : "Unified view"}
          <ChevronsUpDownIcon className="size-3 text-muted-foreground" />
        </button>
        <button
          type="button"
          aria-label="Diff settings"
          className="grid size-8 place-items-center rounded-md border border-border/45 bg-background text-muted-foreground outline-none transition-[background-color,transform] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <AdjustmentsIcon className="size-3.5" />
        </button>
      </div>
      <div role="group" aria-label="Sidebar mode" className="flex items-center gap-1">
        {(["analysis", "info"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            aria-pressed={props.rightTab === tab}
            onClick={() => props.onSelectTab(tab)}
            className={cn(
              "h-7 rounded-md px-2.5 text-[12px] capitalize outline-none transition-[color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              props.rightTab === tab
                ? "bg-muted/50 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/20 hover:text-foreground",
            )}
          >
            {tab}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChangesInPrRail(props: {
  reading: StageReading;
  viewedPaths: ReadonlySet<string>;
  onOpenOverview: () => void;
  onOpenChapter: (chapter: WalkthroughChapter) => void;
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
        {CHAPTERS.map((chapter, index) => (
          <ChangesInPrItem
            key={chapter.id}
            chapter={chapter}
            index={index}
            active={props.reading === chapter.id}
            viewedPaths={props.viewedPaths}
            onOpen={() => props.onOpenChapter(chapter)}
          />
        ))}
      </div>
    </nav>
  );
}

function ChangesInPrItem(props: {
  chapter: WalkthroughChapter;
  index: number;
  active: boolean;
  viewedPaths: ReadonlySet<string>;
  onOpen: () => void;
}): ReactElement {
  const { chapter } = props;
  const stat = chapterDiffStat(chapter);
  const visibleFiles = chapter.files.slice(0, 3);
  const remaining = chapter.files.length - visibleFiles.length;
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
            {chapter.files.length} {chapter.files.length === 1 ? "file" : "files"}
          </span>
          <DiffStat additions={stat.additions} deletions={stat.deletions} className="text-[11px]" />
        </span>
        <span className="mt-1.5 flex flex-col gap-0.5">
          {visibleFiles.map((path) => {
            const parts = splitFilePath(path);
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
          Read explanation
          <ChevronRightIcon className="size-3" />
        </span>
      </span>
    </button>
  );
}

function PrInfoPanel(): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/35 px-4 py-3">
        <InfoIcon className="size-3.5 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold text-foreground">Pull request</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <InfoRow label="Author" value={REVIEW_DETAIL.author} />
        <InfoRow
          label="Branch"
          value={`${REVIEW_DETAIL.headBranch} → ${REVIEW_DETAIL.baseBranch}`}
          mono
        />
        <InfoRow
          label="Changes"
          value={`+${REVIEW_DETAIL.additions} −${REVIEW_DETAIL.deletions} · ${REVIEW_DETAIL.changedFiles} files`}
          mono
        />
        <div>
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Labels</div>
          <div className="flex flex-wrap gap-1.5">
            {REVIEW_DETAIL.labels.map((label) => (
              <LabelPill key={label.name} name={label.name} color={label.color} />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Checks</div>
          <ul className="space-y-1.5">
            {CHECKS.map((check) => (
              <li key={check.name} className="flex min-w-0 items-center gap-2">
                <CheckStateIcon state={check.state} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {check.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function InfoRow(props: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground">{props.label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-[12px] text-foreground",
          props.mono && "font-mono text-[11px] tabular-nums",
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

function DevinChapterReader(props: {
  chapter: WalkthroughChapter;
  completed: boolean;
  splitView: boolean;
  viewedPaths: ReadonlySet<string>;
  onChapterComplete: (chapterId: string) => void;
  onToggleViewed: (path: string) => void;
  onSelectFinding: (finding: ReviewFinding) => void;
  onSelectFile: (path: string) => void;
  onNavigate: (reading: StageReading) => void;
}): ReactElement {
  const { chapter } = props;
  const index = CHAPTERS.findIndex((candidate) => candidate.id === chapter.id);
  const previous: StageReading = index <= 0 ? "overview" : CHAPTERS[index - 1]!.id;
  const next = index >= 0 && index < CHAPTERS.length - 1 ? CHAPTERS[index + 1]! : null;
  const findings = findingsForChapter(chapter);
  const diff = buildChapterDiff(chapter);
  const viewedCount = chapter.files.filter((path) => props.viewedPaths.has(path)).length;

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3 border-b border-border/35 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-muted/40 font-mono text-[12px] leading-none tabular-nums text-foreground">
            {index + 1}
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

      <div className="mt-4 space-y-3">
        {chapter.files.map((path) => {
          const file = CHANGED_FILES.find((candidate) => candidate.path === path) ?? null;
          return (
            <DevinFileDiff
              key={path}
              path={path}
              file={file}
              diff={diff}
              splitView={props.splitView}
              viewed={props.viewedPaths.has(path)}
              onToggleViewed={() => props.onToggleViewed(path)}
              onOpenFile={() => props.onSelectFile(path)}
            />
          );
        })}
      </div>

      {findings.length > 0 ? (
        <section className="mt-5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
            <BugIcon className="size-3.5 text-muted-foreground" />
            Findings
          </div>
          <div className="space-y-2.5">
            {findings.map((finding) => (
              <DevinFindingCard
                key={finding.id}
                finding={finding}
                onSelectFile={props.onSelectFile}
                onSelectFinding={props.onSelectFinding}
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
          onClick={() => props.onNavigate(previous)}
        >
          <ChevronLeftIcon className="size-3.5" />
          {index <= 0 ? "Overview" : "Previous"}
        </Button>
        <Button
          size="sm"
          variant={props.completed ? "outline" : "prominent"}
          className="rounded-full px-3 text-[12px]"
          onClick={() => props.onChapterComplete(chapter.id)}
        >
          <CheckIcon className="size-3.5" />
          {props.completed ? "Reviewed" : "Mark reviewed"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full px-3 text-[12px]"
          disabled={next === null}
          onClick={() => (next ? props.onNavigate(next.id) : undefined)}
        >
          Next
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ChapterExplanation(props: { chapter: WalkthroughChapter }): ReactElement {
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
      <JudgmentCallout question={props.chapter.question} />
    </div>
  );
}

function ProgressRing(props: { viewed: number; total: number }): ReactElement {
  const complete = props.total > 0 && props.viewed >= props.total;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums">
      {complete ? (
        <CircleCheckIcon className="size-3.5 text-success-foreground" />
      ) : (
        <span
          aria-hidden="true"
          className="inline-block size-3.5 rounded-full border-[1.5px] border-muted-foreground/50"
        />
      )}
      <span aria-label={`${props.viewed} of ${props.total} files viewed`}>
        {props.viewed}/{props.total}
      </span>
    </span>
  );
}

function DevinFileDiff(props: {
  path: string;
  file: ReviewChangedFile | null;
  diff: ChapterDiff;
  splitView: boolean;
  viewed: boolean;
  onToggleViewed: () => void;
  onOpenFile: () => void;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const parts = splitFilePath(props.path);
  return (
    <article className="overflow-hidden rounded-lg border border-border/40 bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/35 bg-[var(--color-background-surface)] px-2.5 py-2">
        <button
          type="button"
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-[background-color,transform] duration-150 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={props.onOpenFile}
          className="-mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 outline-none transition-[background-color] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
            {parts.name}
          </span>
          {parts.dir ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {parts.dir}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label="Copy path"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground/70 outline-none transition-[background-color,color] duration-150 hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <CopyIcon className="size-3" />
        </button>
        {props.file ? (
          <DiffStat
            additions={props.file.insertions}
            deletions={props.file.deletions}
            className="ms-auto shrink-0 text-[11px]"
          />
        ) : (
          <span className="ms-auto" />
        )}
        <ViewedToggle viewed={props.viewed} onToggle={props.onToggleViewed} />
        <button
          type="button"
          aria-label="File actions"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-[background-color] duration-150 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </div>
      {collapsed ? null : (
        <div className="overflow-x-auto font-mono text-[12px]">
          <HunkExpander label={`${props.diff.contextAbove} lines`} direction="up" />
          {props.splitView ? (
            <DiffSplit rows={props.diff.rows} hunkHeader={props.diff.hunkHeader} />
          ) : (
            <DiffUnified rows={props.diff.rows} hunkHeader={props.diff.hunkHeader} />
          )}
          <HunkExpander
            label={`All ${props.diff.totalLines} lines`}
            direction="expand"
            trailing={`${props.diff.contextBelow} lines`}
          />
        </div>
      )}
    </article>
  );
}

function ViewedToggle(props: { viewed: boolean; onToggle: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-pressed={props.viewed}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/45 px-2 py-1 text-[11px] text-muted-foreground outline-none transition-[background-color,border-color] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-3.5 place-items-center rounded-[3px] border",
          props.viewed
            ? "border-success-foreground/40 bg-success/20 text-success-foreground"
            : "border-border/60",
        )}
      >
        {props.viewed ? <CheckIcon className="size-2.5" /> : null}
      </span>
      {props.viewed ? "Viewed" : "Mark as viewed"}
    </button>
  );
}

function HunkExpander(props: {
  label: string;
  direction: "up" | "expand";
  trailing?: string;
}): ReactElement {
  const segmentClass =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 outline-none transition-[background-color,color] duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
  return (
    <div className="flex items-center gap-2 border-b border-border/20 bg-muted/20 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <button type="button" className={segmentClass}>
        {props.direction === "up" ? (
          <ChevronUpIcon className="size-3" />
        ) : (
          <ChevronsUpDownIcon className="size-3" />
        )}
        {props.label}
      </button>
      {props.trailing ? (
        <button type="button" className={segmentClass}>
          <ChevronDownIcon className="size-3" />
          {props.trailing}
        </button>
      ) : null}
    </div>
  );
}

function DiffSplit(props: { rows: readonly DiffRow[]; hunkHeader: string }): ReactElement {
  return (
    <div>
      <div className="bg-muted/35 px-3 py-1 text-[11px] text-muted-foreground">
        {props.hunkHeader}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2">
        {props.rows.map((row) => (
          <DiffSplitRow key={`${row.kind}:${String(row.oldNo)}:${String(row.newNo)}`} row={row} />
        ))}
      </div>
    </div>
  );
}

function DiffSplitRow(props: { row: DiffRow }): ReactElement {
  const { row } = props;
  const oldChanged = row.kind === "del" || row.kind === "mod";
  const newChanged = row.kind === "add" || row.kind === "mod";
  return (
    <>
      <DiffCell
        side="old"
        no={row.oldNo}
        text={row.oldText}
        changed={oldChanged}
        empty={row.kind === "add"}
      />
      <DiffCell
        side="new"
        no={row.newNo}
        text={row.newText}
        changed={newChanged}
        empty={row.kind === "del"}
      />
    </>
  );
}

function DiffCell(props: {
  side: "old" | "new";
  no: number | null;
  text: string | null;
  changed: boolean;
  empty: boolean;
}): ReactElement {
  const tint = props.changed
    ? props.side === "old"
      ? "bg-destructive/15"
      : "bg-success/15"
    : props.empty
      ? "bg-muted/15"
      : "";
  const edge = props.changed
    ? props.side === "old"
      ? "border-l-2 border-l-destructive/70"
      : "border-l-2 border-l-success/70"
    : "border-l-2 border-l-transparent";
  return (
    <div
      className={cn("grid grid-cols-[3rem_minmax(0,1fr)] border-b border-border/15", edge, tint)}
    >
      <span className="border-r border-border/20 px-2 py-0.5 text-right text-[10px] text-muted-foreground tabular-nums">
        {props.no ?? ""}
      </span>
      <code className="overflow-x-auto whitespace-pre px-2.5 py-0.5 text-foreground">
        {props.text ?? ""}
      </code>
    </div>
  );
}

interface UnifiedLine {
  readonly no: number | null;
  readonly text: string;
  readonly kind: "add" | "del" | "context";
}

function DiffUnified(props: { rows: readonly DiffRow[]; hunkHeader: string }): ReactElement {
  const lines: readonly UnifiedLine[] = props.rows.flatMap((row): UnifiedLine[] => {
    if (row.kind === "mod") {
      return [
        { no: row.oldNo, text: `- ${row.oldText ?? ""}`, kind: "del" },
        { no: row.newNo, text: `+ ${row.newText ?? ""}`, kind: "add" },
      ];
    }
    if (row.kind === "del") {
      return [{ no: row.oldNo, text: `- ${row.oldText ?? ""}`, kind: "del" }];
    }
    if (row.kind === "add") {
      return [{ no: row.newNo, text: `+ ${row.newText ?? ""}`, kind: "add" }];
    }
    return [{ no: row.newNo, text: `  ${row.newText ?? ""}`, kind: "context" }];
  });
  return (
    <div>
      <div className="bg-muted/35 px-3 py-1 text-[11px] text-muted-foreground">
        {props.hunkHeader}
      </div>
      {lines.map((line) => (
        <div
          key={`${line.kind}:${String(line.no)}:${line.text}`}
          className={cn(
            "grid grid-cols-[3rem_minmax(0,1fr)] border-b border-border/15 border-l-2",
            line.kind === "add" && "border-l-success/70 bg-success/15",
            line.kind === "del" && "border-l-destructive/70 bg-destructive/15",
            line.kind === "context" && "border-l-transparent",
          )}
        >
          <span className="border-r border-border/20 px-2 py-0.5 text-right text-[10px] text-muted-foreground tabular-nums">
            {line.no ?? ""}
          </span>
          <code className="overflow-x-auto whitespace-pre px-2.5 py-0.5 text-foreground">
            {line.text}
          </code>
        </div>
      ))}
    </div>
  );
}

function AskBar(): ReactElement {
  return (
    <div className="shrink-0 border-t border-border/35 bg-[var(--color-background-surface)] px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-border/45 bg-background px-3.5 py-2 shadow-sm">
        <input
          readOnly
          aria-label="Ask anything about this PR"
          placeholder="Ask anything about this PR"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden shrink-0 rounded border border-border/45 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
          ⌘I
        </kbd>
        <button
          type="button"
          aria-label="Send"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background outline-none transition-[opacity,transform] duration-150 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <ComposerSendArrowIcon className="size-3.5 -translate-y-px" />
        </button>
      </div>
    </div>
  );
}

function ProloguePanel(props: { onStart: (reading: StageReading) => void }): ReactElement {
  const firstChapter = CHAPTERS[0];
  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-7 sm:px-7">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <SparklesIcon className="size-3.5" />
        Overview
      </div>
      <h1 className="mt-2 text-balance text-[26px] font-semibold leading-8 text-foreground">
        {REVIEW_DETAIL.title}
      </h1>
      <p className="mt-3 max-w-2xl text-[14px] leading-6 text-muted-foreground">
        {REVIEW_DETAIL.body}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <ProseCard icon={<InfoIcon className="size-3.5" />} label="Why this change" tone="info">
          {PROLOGUE.motivation}
        </ProseCard>
        <ProseCard
          icon={<CircleCheckIcon className="size-3.5" />}
          label="What's better now"
          tone="success"
        >
          {PROLOGUE.outcome}
        </ProseCard>
      </div>

      <ComplexityMeter
        level={PROLOGUE.complexity.level}
        reasoning={PROLOGUE.complexity.reasoning}
      />

      <section className="mt-8">
        <SectionHeading icon={<ListChecksIcon className="size-4" />} title="Key changes" />
        <ul className="mt-3 space-y-2.5">
          {PROLOGUE.keyChanges.map((change) => (
            <li key={change.summary} className="flex min-w-0 items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/45"
              />
              <span className="min-w-0">
                <span className="text-[13px] font-medium text-foreground">{change.summary}</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
                  {change.description}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <SectionHeading
          icon={<TriangleAlertIcon className="size-4" />}
          title="Where to look closely"
        />
        <div className="mt-3 space-y-2.5">
          {PROLOGUE.focusAreas.map((area) => (
            <FocusAreaCard key={area.title} area={area} />
          ))}
        </div>
      </section>

      {firstChapter ? (
        <div className="mt-9 flex justify-end border-t border-border/35 pt-5">
          <Button
            size="sm"
            variant="prominent"
            className="px-3.5 text-[12px]"
            onClick={() => props.onStart(firstChapter.id)}
          >
            Start reading
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </article>
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

function DevinFindingCard(props: {
  finding: ReviewFinding;
  onSelectFile: (path: string) => void;
  onSelectFinding: (finding: ReviewFinding) => void;
}): ReactElement {
  const { finding } = props;
  const category = findingCategoryMeta(finding.category);
  return (
    <article className="overflow-hidden rounded-lg border border-border/45 bg-background">
      <div className="flex min-w-0 items-start gap-2.5 px-3.5 pt-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            category.iconClassName,
          )}
        >
          {category.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ReviewPill tone={category.tone}>{category.label}</ReviewPill>
            <SeverityPill severity={finding.severity} />
            <ConfidencePill confidence={finding.confidence} />
          </div>
          <h4 className="mt-2 text-[13px] font-semibold leading-5 text-foreground">
            {finding.title}
          </h4>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{finding.summary}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => props.onSelectFile(finding.file)}
        className="mx-3.5 mt-3 flex min-w-0 max-w-[calc(100%-1.75rem)] items-center gap-2 rounded bg-muted/30 px-2 py-1.5 text-left outline-none transition-[background-color] duration-150 hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <DiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {finding.file}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          L{finding.line}
        </span>
      </button>
      <div className="mx-3.5 mt-2.5 rounded border border-border/35 bg-muted/12 px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <SparklesIcon className="size-3" />
          Suggested fix
        </div>
        <p className="mt-1 text-[12px] leading-5 text-foreground">{finding.suggestedFix}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/30 px-3.5 py-2.5">
        <Button
          size="xs"
          variant="prominent"
          className="h-6 px-2 text-[11px]"
          onClick={() => props.onSelectFinding(finding)}
        >
          Address
        </Button>
        <Button size="xs" variant="outline" className="h-6 rounded-full px-2 text-[11px]">
          Comment
        </Button>
        <Button size="xs" variant="ghost" className="h-6 rounded-full px-2 text-[11px]">
          Dismiss
        </Button>
        <ReviewPill tone={finding.status === "open" ? "warning" : "muted"} className="ms-auto">
          {finding.status}
        </ReviewPill>
      </div>
    </article>
  );
}

function ConfidencePill(props: { confidence: number }): ReactElement {
  const pct = Math.round(props.confidence * 100);
  const tone: "success" | "warning" | "muted" =
    pct >= 85 ? "success" : pct >= 70 ? "warning" : "muted";
  return (
    <ReviewPill tone={tone} icon={<BotIcon className="size-3" />}>
      {pct}% confident
    </ReviewPill>
  );
}

function FocusAreaCard(props: { area: PrologueFocusArea }): ReactElement {
  const meta = focusAreaTypeMeta(props.area.type);
  return (
    <div className="rounded-lg border border-border/40 bg-background px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            meta.iconClassName,
          )}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-foreground">{props.area.title}</span>
            <ReviewPill tone={focusAreaSeverityTone(props.area.severity)}>
              {props.area.severity}
            </ReviewPill>
            <ReviewPill tone="muted">{meta.label}</ReviewPill>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {props.area.description}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {props.area.locations.map((location) => (
              <span
                key={location}
                className="max-w-full truncate font-mono text-[10px] text-muted-foreground"
              >
                {location}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ComplexityMeter(props: { level: ComplexityLevel; reasoning: string }): ReactElement {
  const order: readonly ComplexityLevel[] = ["low", "medium", "high", "very-high"];
  const filled = order.indexOf(props.level) + 1;
  const labelMap: Record<ComplexityLevel, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    "very-high": "Very high",
  };
  return (
    <div className="mt-3 rounded-lg border border-border/35 bg-background px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ChartBarIcon className="size-3.5" />
          Complexity
        </span>
        <span className="text-[12px] font-semibold text-foreground">{labelMap[props.level]}</span>
        <span className="flex items-center gap-1" aria-hidden="true">
          {order.map((level, index) => (
            <span
              key={level}
              className={cn(
                "h-1.5 w-7 rounded-full",
                index < filled ? "bg-foreground/70" : "bg-muted",
              )}
            />
          ))}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{props.reasoning}</p>
    </div>
  );
}

function ProseCard(props: {
  icon: ReactNode;
  label: string;
  tone: "info" | "success";
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-lg border border-border/35 bg-background px-3.5 py-3">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide",
          props.tone === "success" ? "text-success-foreground" : "text-info-foreground",
        )}
      >
        {props.icon}
        {props.label}
      </div>
      <p className="mt-1.5 text-[13px] leading-6 text-foreground">{props.children}</p>
    </div>
  );
}

function SectionHeading(props: { icon: ReactNode; title: string }): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border/35 pb-2 text-foreground">
      <span className="text-muted-foreground">{props.icon}</span>
      <h2 className="text-[15px] font-semibold">{props.title}</h2>
    </div>
  );
}

function focusAreaTypeMeta(type: FocusAreaType): {
  label: string;
  icon: ReactNode;
  iconClassName: string;
} {
  switch (type) {
    case "security":
      return {
        label: "Security",
        icon: <LockIcon className="size-3.5" />,
        iconClassName: "bg-destructive/12 text-destructive",
      };
    case "performance":
      return {
        label: "Performance",
        icon: <ClockIcon className="size-3.5" />,
        iconClassName: "bg-info/12 text-info-foreground",
      };
    case "data-integrity":
      return {
        label: "Data integrity",
        icon: <TriangleAlertIcon className="size-3.5" />,
        iconClassName: "bg-warning/12 text-warning-foreground",
      };
    case "architecture":
      return {
        label: "Architecture",
        icon: <GitPullRequestIcon className="size-3.5" />,
        iconClassName: "bg-muted text-muted-foreground",
      };
    case "testing-gap":
      return {
        label: "Testing gap",
        icon: <CircleAlertIcon className="size-3.5" />,
        iconClassName: "bg-info/12 text-info-foreground",
      };
    default:
      return {
        label: "Heads up",
        icon: <InfoIcon className="size-3.5" />,
        iconClassName: "bg-muted text-muted-foreground",
      };
  }
}

function focusAreaSeverityTone(
  severity: FocusAreaSeverity,
): "danger" | "warning" | "info" | "muted" {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "medium":
      return "info";
    case "info":
      return "muted";
  }
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
    summary: "The overview should make it obvious which files have not been inspected yet.",
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

function DiffWorkspace(
  props: PrototypeModel & { compact?: boolean; hideFileTree?: boolean },
): ReactElement {
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
      '- const reviewMode = tab === "files" ? "files" : "conversation";',
      '+ const reviewMode = tab === "walkthrough" ? "walkthrough" : tab;',
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
      <span>
        completed: {props.completedCount}/{CHAPTERS.length}
      </span>
      <span>
        viewed files: {props.viewedCount}/{CHANGED_FILES.length}
      </span>
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

  const currentVariant = WALKTHROUGH_PROTOTYPE_VARIANTS.find((variant) => variant.id === current)!;

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
