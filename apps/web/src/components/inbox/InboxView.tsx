// FILE: InboxView.tsx
// Purpose: The Inbox page (Beta-only): a task column (what needs the user, what is running,
//          what finished) beside the day told as short written cards ("Your best model
//          was ..."). Cards and groups exist only when the user's data does, and the grid
//          closes the gaps they leave. Colors come from the theme.
// Layer: Inbox route surface
// Exports: InboxView (default)

import type {
  SavedInboxRecap,
  ServerProviderUsageSnapshot,
  StatsGetRecapResult,
  ThreadId,
} from "@synara/contracts";
import {
  providerUsageDisplayName,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { pluralize } from "@synara/shared/text";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { INBOX_ON } from "~/betaFeatures";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { resolveProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { useActivityThreads } from "~/hooks/useActivityThreads";
import { useDismissedThreadStatusKeys } from "~/hooks/useDismissedThreadStatusKeys";
import { useNowMs } from "~/hooks/useNowMs";
import { githubInboxReviewBadgeQueryOptions } from "~/lib/pullRequestReactQuery";
import {
  deriveProviderUsageDisplayRows,
  providerUsageProgressTrackProps,
} from "~/lib/providerUsageDisplay";
import { deriveAccountRateLimits } from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverRecapQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { automationAttentionCount, automationQueryKey } from "~/routes/-automations.shared";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { createAccountRateLimitThreadsSelector } from "~/storeSelectors";
import type { Project } from "~/types";
import { formatNumber } from "@synara/profile-ui/formatting";
import { ProjectSidebarIcon } from "../ProjectSidebarIcon";
import { ProviderIcon } from "../ProviderIcon";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurfaceHeader } from "../RouteSurface";
import { resolvePullRequestReviewBadge } from "../Sidebar.logic";
import { collectUnreadActivityThreads } from "../SidebarActivityView.logic";
import { UsageProgressTrack } from "../UsageProgressTrack";
import {
  groupInboxThreads,
  recapBucketsByStart,
  recapInputForRange,
  recapTokens,
  previousDayCutoffMs,
  resolveInboxDay,
  sumRecapBefore,
  summarizeInboxSlots,
  type InboxDay,
  type InboxSlotId,
  type InboxSlotSummary,
} from "./inbox.logic";
import {
  buildInboxDigest,
  buildInboxTiles,
  type DigestPart,
  type DigestSentence,
  type InboxIcon,
  type InboxQuotaSummary,
  type InboxTile,
  type InboxTone,
} from "./inboxStories";
import { InboxTaskList } from "./InboxTaskList";
import { InboxRecapHistory } from "./InboxRecapHistory";

// A turn finishing refreshes the recap, at most this often, so busy automations cannot
// keep the server's recap query running back to back.
const RECAP_REFETCH_MIN_INTERVAL_MS = 20_000;

const CLOCK_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const LONG_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** The server refuses the recap (a Stable server): retrying cannot help. */
function isRecapUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FEATURE_UNAVAILABLE"
  );
}

const GREETINGS: Record<InboxSlotId, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
};

// The page and the recap column are size containers: cards follow the room they actually
// get beside the sidebar and panels, from a phone (one column) through an iPad to a desktop
// (task column plus digest and tiles). Tailwind only ships classes it reads in source, so
// the column counts are spelled out.
const SLOT_GRID_COLUMNS: Record<number, string> = {
  1: "",
  2: "grid-cols-2",
  3: "grid-cols-3",
};
const TILE_SPAN_WIDE: Record<number, string> = {
  2: "@2xl:col-span-2",
  3: "@2xl:col-span-3",
  6: "@2xl:col-span-6",
};

/**
 * Tiles sit on a six-column grid when wide, so any count fills its rows: three per row,
 * and a last row of two or one stretches across (four tiles become two by two).
 * Narrower, they pair up two by two and an odd last tile takes the whole row.
 */
function tileSpanClassName(index: number, count: number): string {
  const perRow = count === 4 ? 2 : 3;
  const lastRowStart = count - (count % perRow || perRow);
  const inLastRow = index >= lastRowStart;
  const rowCount = inLastRow ? count - lastRowStart : perRow;
  const wide = TILE_SPAN_WIDE[6 / rowCount] ?? "@2xl:col-span-2";
  const narrowOdd = count % 2 === 1 && index === count - 1 ? "col-span-2" : "";
  return cn(narrowOdd, wide);
}

function Tile({ className, children }: { className?: string | undefined; children: ReactNode }) {
  return <section className={cn("min-w-0 rounded-2xl bg-muted", className)}>{children}</section>;
}

/** A provider logo or project favicon sized by the caller (text-sized in the digest). */
function InboxGlyph({
  icon,
  projectById,
  className,
}: {
  icon: InboxIcon | undefined;
  projectById: ReadonlyMap<string, Project>;
  className: string;
}) {
  if (!icon) return null;
  if (icon.kind === "provider") {
    return <ProviderIcon provider={icon.provider} className={cn("shrink-0", className)} />;
  }
  const project = projectById.get(icon.projectId);
  return project?.cwd ? (
    <ProjectSidebarIcon
      cwd={project.cwd}
      expanded={false}
      appearance={project.appearance}
      glyphClassName={cn("shrink-0", className)}
      presentation="favicon"
    />
  ) : null;
}

const TONE_CLASS_NAME: Record<InboxTone, string> = {
  good: "text-status-success",
  bad: "text-destructive",
};

/** Morning, afternoon, and evening side by side, each with its prompts and hourly bars. */
function SlotColumns({ slots }: { slots: readonly InboxSlotSummary[] }) {
  const maxTokens = Math.max(1, ...slots.flatMap((slot) => slot.hours.map((hour) => hour.tokens)));
  return (
    <div className={cn("grid gap-4 @lg:gap-7", SLOT_GRID_COLUMNS[slots.length])}>
      {slots.map((slot) => (
        <div key={slot.id} className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2 text-ui-sm text-muted-foreground">
            <span>
              {slot.label}
              {slot.status === "now" ? <span className="text-foreground">, now</span> : null}
            </span>
            <span className="tabular-nums">
              <span className={cn(slot.status === "now" && "font-medium text-foreground")}>
                {formatNumber(slot.prompts)}
              </span>{" "}
              {pluralize(slot.prompts, "prompt")}
            </span>
          </div>
          <div className="flex h-7 items-end justify-between gap-[3px]" aria-hidden>
            {slot.hours.map((hour) => (
              <span
                key={hour.fromMs}
                className={cn(
                  "min-h-[3px] w-full max-w-2 rounded-[2px]",
                  hour.future || hour.tokens === 0
                    ? "bg-foreground/8"
                    : slot.status === "now"
                      ? "bg-foreground"
                      : "bg-muted-foreground/45",
                )}
                style={{ height: `${Math.round((hour.tokens / maxTokens) * 100)}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// A part's key is its offset in the sentence: stable for the same text, unique within it.
function keyedParts(parts: readonly DigestPart[]) {
  let offset = 0;
  return parts.map((part) => {
    const key = `${part.kind}:${offset}`;
    offset += part.text.length;
    return { key, part };
  });
}

/**
 * The day told in a few sentences. Facts read in the foreground color with their logo
 * inline; the rest of the sentence stays quiet. This is the page's lede, so it reads a size
 * above body text.
 */
function DigestCard({
  sentences,
  slots,
  updatedAt,
  projectById,
  title = "Your day so far",
}: {
  sentences: readonly DigestSentence[];
  slots: readonly InboxSlotSummary[];
  updatedAt: string;
  projectById: ReadonlyMap<string, Project>;
  title?: string;
}) {
  return (
    <Tile className="flex flex-col gap-5 p-5 @lg:px-7 @lg:py-6">
      <div className="flex items-baseline justify-between gap-3 text-ui-sm text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums opacity-80">Updated {updatedAt}</span>
      </div>
      <p className="max-w-[62ch] text-ui-xl leading-relaxed text-pretty text-muted-foreground">
        {sentences.map((sentence, sentenceIndex) => (
          <span key={sentence.id}>
            {sentenceIndex > 0 ? " " : null}
            {keyedParts(sentence.parts).map(({ key, part }) =>
              part.kind === "text" ? (
                <span key={key}>{part.text}</span>
              ) : (
                <span
                  key={key}
                  className={cn(
                    "font-medium",
                    part.tone ? TONE_CLASS_NAME[part.tone] : "text-foreground",
                    part.icon && "whitespace-nowrap",
                  )}
                >
                  {part.icon ? (
                    <InboxGlyph
                      icon={part.icon}
                      projectById={projectById}
                      className="mr-1 inline-block size-[1em] align-[-0.125em]"
                    />
                  ) : null}
                  {part.text}
                </span>
              ),
            )}
          </span>
        ))}
      </p>
      {slots.length > 0 ? (
        <div className="border-t border-border pt-4">
          <SlotColumns slots={slots} />
        </div>
      ) : null}
    </Tile>
  );
}

function tokenLine(values: readonly number[], count: number, max: number): string {
  return values
    .map((value, index) => {
      const x = count > 1 ? (index / (count - 1)) * 64 : 0;
      const y = 19 - (value / max) * 17;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** A tiny tokens-by-hour line on a whole-day axis, so it stops where "now" is. */
function TokenSpark({ today, hoursInDay }: { today: readonly number[]; hoursInDay: number }) {
  const max = Math.max(1, ...today);
  return (
    // Only where the tile has room beside the value; on a phone the number matters more.
    <svg
      viewBox="0 0 64 20"
      className="ml-auto hidden h-5 w-16 shrink-0 text-foreground @2xl:block"
      aria-hidden
    >
      <polyline
        points={tokenLine(today, Math.max(hoursInDay, 2), max)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One compact tile: a quiet lead, the value with its logo, and one short line. */
function CompactTile({
  tile,
  projectById,
  visual,
  className,
}: {
  tile: InboxTile;
  projectById: ReadonlyMap<string, Project>;
  visual?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Tile
      className={cn(
        "flex min-h-26 flex-col justify-between gap-2.5 px-3.5 py-3 @md:min-h-28 @md:gap-3 @md:px-4 @md:py-3.5",
        className,
      )}
    >
      <span className="truncate text-ui-sm text-muted-foreground">{tile.lead}</span>
      <span className="flex min-w-0 items-center gap-2">
        <InboxGlyph icon={tile.icon} projectById={projectById} className="size-[18px]" />
        <span className="min-w-0 truncate text-ui-xl font-medium tracking-tight text-foreground tabular-nums">
          {tile.value}
        </span>
        {visual}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {tile.track ? (
          <UsageProgressTrack
            {...tile.track}
            className="h-1 w-14 shrink-0 bg-foreground/8"
            markerGapClassName="bg-muted"
          />
        ) : null}
        <span
          className={cn(
            "truncate text-ui-sm",
            tile.detailTone ? TONE_CLASS_NAME[tile.detailTone] : "text-muted-foreground",
          )}
        >
          {tile.detail}
        </span>
      </span>
    </Tile>
  );
}

function useQuotaSummaries(snapshots: readonly ServerProviderUsageSnapshot[]): InboxQuotaSummary[] {
  // Rate-limit activities only: this stays put while other activities stream in.
  const threads = useStore(useMemo(() => createAccountRateLimitThreadsSelector(), []));
  const accountRateLimits = useMemo(() => deriveAccountRateLimits(threads), [threads]);
  return useMemo(
    () =>
      snapshots.flatMap((snapshot) => {
        const summary = resolveProviderUsageSummary({
          provider: snapshot.provider,
          accountRateLimits,
          authoritativeLiveSnapshot: snapshot,
        });
        return deriveProviderUsageDisplayRows(summary.rateLimits).map((row) => ({
          provider: snapshot.provider,
          name: providerUsageDisplayName(snapshot.provider),
          window: row.label,
          remainingPercent: row.remainingPercent,
          resetText: row.resetText,
          track: providerUsageProgressTrackProps(row),
        }));
      }),
    [accountRateLimits, snapshots],
  );
}

function RecapSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-48 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="col-span-2 h-28 rounded-2xl @2xl:col-span-1" />
      </div>
    </div>
  );
}

function RecapDigest({
  day,
  nowMs,
  recap,
  previousRecap,
  quota,
  projectById,
}: {
  day: InboxDay;
  nowMs: number;
  recap: StatsGetRecapResult;
  previousRecap: StatsGetRecapResult | undefined;
  quota: readonly InboxQuotaSummary[];
  projectById: ReadonlyMap<string, Project>;
}) {
  const slots = summarizeInboxSlots(recap, day, nowMs);
  // Yesterday up to the time today's numbers were taken, so a morning is never compared
  // with a whole day and a recap that is a few minutes old is not compared with a newer one.
  const asOfMs = Date.parse(recap.generatedAt) || nowMs;
  const yesterdaySoFar = previousRecap
    ? sumRecapBefore(previousRecap, day.previousDay, previousDayCutoffMs(asOfMs))
    : null;
  const input = { recap, previousRecap, yesterdaySoFar, slots };
  const sentences = buildInboxDigest(input);
  const tiles = buildInboxTiles({ ...input, quota });
  const bucketByStart = recapBucketsByStart(recap);
  const todayHourly = day.hours
    .filter((hour) => hour.fromMs <= nowMs)
    .map((hour) => {
      const bucket = bucketByStart.get(hour.fromMs);
      return bucket ? recapTokens(bucket) : 0;
    });
  const updatedAt = CLOCK_TIME_FORMAT.format(asOfMs);

  return (
    <div className="flex flex-col gap-3">
      {sentences.length > 0 ? (
        <DigestCard
          sentences={sentences}
          slots={slots}
          updatedAt={updatedAt}
          projectById={projectById}
        />
      ) : (
        <Tile className="p-5 @lg:px-7 @lg:py-6">
          <p className="text-ui-lg text-muted-foreground">
            Nothing ran yet today. This fills in as your agents work.
          </p>
        </Tile>
      )}
      {tiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-6">
          {tiles.map((tile, index) => (
            <CompactTile
              key={tile.id}
              className={tileSpanClassName(index, tiles.length)}
              tile={tile}
              projectById={projectById}
              visual={
                tile.id === "tokens" ? (
                  <TokenSpark today={todayHourly} hoursInDay={day.hours.length} />
                ) : null
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SavedRecapDigest({ saved }: { saved: SavedInboxRecap }) {
  // A saved project's raw ID belongs to its source host, not the current workspace.
  const projectById: ReadonlyMap<string, Project> = new Map();
  const hourFormat = new Intl.DateTimeFormat("en", {
    timeZone: saved.timezone,
    hour: "numeric",
    hourCycle: "h23",
  });
  const asOfMs = Date.parse(saved.recap.generatedAt);
  const slots: InboxSlotSummary[] = [];
  for (const id of ["morning", "afternoon", "evening"] as const) {
    const buckets = saved.recap.slots.filter((bucket) => {
      const from = Date.parse(bucket.from);
      const hour = Number(hourFormat.format(from));
      const bucketId = hour >= 18 || hour < 4 ? "evening" : hour >= 12 ? "afternoon" : "morning";
      return bucketId === id && from <= asOfMs;
    });
    if (buckets.length === 0) continue;
    slots.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      status: "done",
      prompts: buckets.reduce((total, bucket) => total + bucket.prompts, 0),
      turns: buckets.reduce((total, bucket) => total + bucket.turns, 0),
      tokens: buckets.reduce((total, bucket) => total + recapTokens(bucket), 0),
      agentWorkMs: buckets.reduce((total, bucket) => total + bucket.agentWorkMs, 0),
      hours: buckets.map((bucket) => ({
        fromMs: Date.parse(bucket.from),
        tokens: recapTokens(bucket),
        future: false,
      })),
    });
  }
  const input = { recap: saved.recap, previousRecap: undefined, yesterdaySoFar: null, slots };
  const tiles = buildInboxTiles({ ...input, quota: [] });
  return (
    <div className="flex flex-col gap-3">
      <DigestCard
        title="Saved recap"
        sentences={buildInboxDigest(input)}
        slots={slots}
        updatedAt={new Intl.DateTimeFormat(undefined, {
          timeZone: saved.timezone,
          hour: "2-digit",
          minute: "2-digit",
        }).format(asOfMs)}
        projectById={projectById}
      />
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-6">
        {tiles.map((tile, index) => (
          <CompactTile
            key={tile.id}
            tile={tile}
            projectById={projectById}
            className={tileSpanClassName(index, tiles.length)}
          />
        ))}
      </div>
    </div>
  );
}

export default function InboxView() {
  const navigate = useNavigate();
  const inboxAvailable = INBOX_ON;
  useEffect(() => {
    if (!inboxAvailable) void navigate({ to: "/", replace: true });
  }, [inboxAvailable, navigate]);

  const nowMs = useNowMs(true, 60_000);
  const day = resolveInboxDay(nowMs);

  const { settings } = useAppSettings();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const projects = useStore((store) => store.projects);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const projectById = useMemo(
    () => new Map<string, Project>(projects.map((project) => [project.id, project])),
    [projects],
  );
  const dismissedStatusKeys = useDismissedThreadStatusKeys();
  const { visibleNonGroupThreads } = useActivityThreads({
    hideAutomationRunThreads: !settings.showAutomationRunThreads,
  });
  const groups = useMemo(
    () => groupInboxThreads(visibleNonGroupThreads, dismissedStatusKeys),
    [dismissedStatusKeys, visibleNonGroupThreads],
  );

  // The recap windows only move when the working day does (keyed by its start).
  const dayStartMs = day.fromMs;
  const { todayInput, previousDayInput } = useMemo(() => {
    const workingDay = resolveInboxDay(dayStartMs);
    return {
      todayInput: recapInputForRange(workingDay),
      previousDayInput: recapInputForRange(workingDay.previousDay),
    };
  }, [dayStartMs]);
  const recapQuery = useQuery(serverRecapQueryOptions(todayInput, { enabled: inboxAvailable }));
  // Refresh the recap when a turn finishes while the Inbox is open, instead of waiting for
  // the next poll: the newest completion across the visible threads changes exactly then.
  // Completions that land close together share one refresh.
  const latestCompletionAt = useMemo(() => {
    let latest = "";
    for (const thread of visibleNonGroupThreads) {
      const completedAt = thread.latestTurn?.completedAt ?? "";
      if (completedAt > latest) latest = completedAt;
    }
    return latest;
  }, [visibleNonGroupThreads]);
  const refetchRecap = recapQuery.refetch;
  const seenCompletionAtRef = useRef(latestCompletionAt);
  const lastCompletionRefetchAtRef = useRef(0);
  useEffect(() => {
    if (!inboxAvailable || seenCompletionAtRef.current === latestCompletionAt) return;
    const waitMs = Math.max(
      0,
      lastCompletionRefetchAtRef.current + RECAP_REFETCH_MIN_INTERVAL_MS - Date.now(),
    );
    const timer = window.setTimeout(() => {
      seenCompletionAtRef.current = latestCompletionAt;
      lastCompletionRefetchAtRef.current = Date.now();
      void refetchRecap();
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [inboxAvailable, latestCompletionAt, refetchRecap]);
  // Yesterday waits for today so the page never holds two expensive reads at once.
  const previousRecapQuery = useQuery(
    serverRecapQueryOptions(previousDayInput, {
      enabled: inboxAvailable && recapQuery.isSuccess,
      live: false,
    }),
  );
  // Only asked when there is a GitHub-backed project to ask about.
  const reviewRequestQuery = useQuery({
    ...githubInboxReviewBadgeQueryOptions(),
    enabled: inboxAvailable && projects.some((project) => project.kind === "project"),
  });
  // Shares the ["automations"] cache the sidebar keeps live.
  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
    enabled: inboxAvailable,
  });
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions(inboxAvailable));
  const quotaSnapshots = useMemo(
    () =>
      selectVisibleProviderUsageSnapshots(usageQuery.data ?? []).filter(
        (snapshot) => (snapshot.status ?? "ok") === "ok",
      ),
    [usageQuery.data],
  );
  const quota = useQuotaSummaries(quotaSnapshots);

  const reviewRequestBadge = resolvePullRequestReviewBadge(reviewRequestQuery.data);
  const reviewRequests =
    reviewRequestBadge && reviewRequestQuery.data
      ? { count: reviewRequestQuery.data.count, badge: reviewRequestBadge }
      : null;
  const reviewRequestCount = reviewRequests?.count ?? 0;
  const automationAttention = automationsQuery.data
    ? automationAttentionCount(automationsQuery.data.runs)
    : 0;
  const hasTasks =
    groups.needsYou.length +
      groups.working.length +
      groups.finished.length +
      groups.failed.length +
      reviewRequestCount +
      automationAttention >
    0;
  const needsYouCount = groups.needsYou.length + reviewRequestCount + automationAttention;

  const openThread = (threadId: ThreadId) => {
    void navigate({ to: "/$threadId", params: { threadId } });
  };
  // Same set as the Activity view's "Mark all as read": finished and failed alike.
  const unreadThreads = useMemo(
    () => collectUnreadActivityThreads(visibleNonGroupThreads),
    [visibleNonGroupThreads],
  );
  const markAllRead = () => {
    for (const thread of unreadThreads) {
      markThreadVisited(thread.id, thread.latestTurn?.completedAt ?? undefined);
    }
  };
  const dateLabel = LONG_DATE_FORMAT.format(nowMs);

  if (!inboxAvailable) return null;

  const summary = !threadsHydrated
    ? `${dateLabel}.`
    : needsYouCount > 0
      ? `${dateLabel}. ${needsYouCount} ${needsYouCount === 1 ? "thing needs" : "things need"} you.`
      : hasTasks
        ? `${dateLabel}.`
        : `${dateLabel}. You’re all caught up.`;

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader divider={false} className="shrink-0" rowClassName="sm:gap-2" />
        <div className="@container min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pt-1 pb-12 @2xl:gap-6 @2xl:px-6 @2xl:pt-2 @5xl:px-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-2xl font-medium tracking-tight text-foreground @2xl:text-3xl">
                  Inbox
                </h1>
                <p className="text-ui text-muted-foreground @2xl:text-ui-lg">
                  {GREETINGS[day.currentSlotId]}. {summary}
                </p>
              </div>
              {unreadThreads.length > 0 ? (
                <Button variant="outline" size="sm" className="rounded-full" onClick={markAllRead}>
                  Mark all read
                </Button>
              ) : null}
            </div>

            <div className={cn("grid gap-3 @2xl:gap-4", hasTasks && "@5xl:grid-cols-12")}>
              {hasTasks ? (
                <Tile className="self-start px-2 py-3 @5xl:col-span-4">
                  <InboxTaskList
                    groups={groups}
                    projectById={projectById}
                    reviewRequests={reviewRequests}
                    automationAttention={automationAttention}
                    onOpenThread={openThread}
                    onOpenPullRequests={() =>
                      void navigate({
                        to: "/pull-requests",
                        search: {
                          type: "pullRequest",
                          involvement: "reviewRequested",
                          state: "open",
                        },
                      })
                    }
                    onOpenAutomations={() => void navigate({ to: "/automations" })}
                  />
                </Tile>
              ) : null}
              <div className={cn("@container min-w-0", hasTasks && "@5xl:col-span-8")}>
                {/* A failed refresh keeps the last good recap on screen. */}
                {recapQuery.data ? (
                  <RecapDigest
                    day={day}
                    nowMs={nowMs}
                    recap={recapQuery.data}
                    previousRecap={previousRecapQuery.data}
                    quota={quota}
                    projectById={projectById}
                  />
                ) : isRecapUnavailableError(recapQuery.error) ? (
                  <Tile className="p-5 @lg:px-7 @lg:py-6">
                    <span className="text-ui text-muted-foreground">
                      The day recap needs a server running Synara Beta.
                    </span>
                  </Tile>
                ) : recapQuery.isError ? (
                  <Tile className="flex items-center justify-between gap-3 p-5 @lg:px-7 @lg:py-6">
                    <span className="text-ui text-muted-foreground">The recap didn’t load.</span>
                    <Button size="xs" variant="outline" onClick={() => void recapQuery.refetch()}>
                      Try again
                    </Button>
                  </Tile>
                ) : (
                  <RecapSkeleton />
                )}
              </div>
            </div>
            <InboxRecapHistory
              recap={recapQuery.data}
              renderRecap={(saved) => <SavedRecapDigest saved={saved} />}
            />
          </div>
        </div>
      </div>
    </RouteInsetSurface>
  );
}
