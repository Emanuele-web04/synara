// FILE: SubagentRunCard.tsx
// Purpose: The transcript card a turn's subagents fold into, at the point the
// parent launched them: a header ("2 subagents · 1 running · 12s", Stop all) and
// one row per subagent (status dot, name, role, model, live state with the
// current command, or the past-tense outcome with a one-line result). Nested
// subagents sit collapsed under the row that launched them. Live cards start
// expanded; finished ones fold into a single work row that expands on click.
// Layer: Chat transcript UI
// Exports: SubagentRunCard, SubagentIdentityLine

import { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import {
  BackgroundTrayIcon,
  ChatBubbleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  StopIcon,
} from "~/lib/icons";
import {
  subagentOutcomeTextToneClassName,
  subagentStatusDotClassName,
  subagentStatusTextToneClassName,
} from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { WorkLogEntry } from "../../session-logic";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { LiveStatusSpinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-chip";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";
import {
  collectLiveSubagentRunItems,
  deriveSubagentRunCard,
  describeSubagentRunHeader,
  describeSubagentRunRow,
  isLaunchTurnLive,
  type SubagentRunAction,
  type SubagentRunRow,
} from "./SubagentRunCard.logic";
import { useSubagentRunContext, type SubagentRunContextValue } from "./subagentRunContext";

const EMPTY_THREADS: SubagentRunContextValue["threads"] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_TASK_ENDS: SubagentRunContextValue["taskEndByToolUseId"] = new Map();

/** Name, role, and model of one subagent: the identity line every row shares. */
export function SubagentIdentityLine({ item }: { item: ComposerSubagentStripItem }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" title={item.fullLabel}>
      <span className="min-w-0 truncate font-medium text-foreground/88">{item.primaryLabel}</span>
      {item.role ? (
        <span className="shrink-0 text-ui-sm text-muted-foreground/60">{item.role}</span>
      ) : null}
      {item.modelLabel ? (
        <span className="shrink-0 text-ui-sm text-muted-foreground/48">{item.modelLabel}</span>
      ) : null}
      {item.isBackground ? (
        <span className="shrink-0 text-ui-sm text-muted-foreground/48">background</span>
      ) : null}
    </span>
  );
}

// Backticked spans in a one-line preview render as inline code, like the
// subagent's own reply does.
function renderInlineCode(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3) return text;
  return parts.map((part, index) =>
    index % 2 === 1 && index < parts.length - 1 ? (
      <code key={index}>{part}</code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function ActionText({ action }: { action: SubagentRunAction }) {
  return action.command ? (
    <code className="min-w-0 truncate">{action.command}</code>
  ) : (
    <span className="min-w-0 truncate">{action.label}</span>
  );
}

function Separator() {
  return <span className="shrink-0 text-muted-foreground/40">·</span>;
}

function SubagentRunRowView({
  row,
  nowMs,
  allStopped,
  depth,
  context,
}: {
  row: SubagentRunRow;
  nowMs: number;
  allStopped: boolean;
  depth: number;
  context: SubagentRunContextValue | null;
}) {
  const [nestedOpen, setNestedOpen] = useState(false);
  const description = describeSubagentRunRow(row, { nowMs, allStopped });
  const live = row.phase === "running" || row.phase === "waiting" || row.phase === "starting";
  const { threadId } = row;
  const openThread = threadId && context ? () => context.onOpenThread(threadId) : undefined;
  const onStop = context?.onStop;
  const onBackground = context?.onBackground;
  const ended = !live;
  const wordToneClassName = ended
    ? subagentOutcomeTextToneClassName(description.statusKind)
    : subagentStatusTextToneClassName(description.statusKind);

  return (
    <div data-testid="subagent-run-row" data-phase={row.phase} data-depth={depth}>
      <div className="group/subagent-row relative flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-within:bg-[var(--color-background-button-secondary-hover)] [&>button:not(:first-child)]:relative [&>button:not(:first-child)]:z-[1]">
        {/* The open button stretches over the whole row (chevron included);
            the row's own controls sit above it. */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2.5 py-0.5 text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-1 focus-visible:after:ring-ring/60 disabled:cursor-default"
          disabled={!openThread}
          onClick={openThread}
          aria-label={`Open ${row.item.primaryLabel}`}
        >
          <StatusDot
            className={cn("mt-[0.5em]", subagentStatusDotClassName(description.statusKind))}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SubagentIdentityLine item={row.item} />
            <span className="chat-markdown flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground/70">
              {live || row.phase === "starting" ? (
                <LiveStatusSpinner className={cn("size-3 shrink-0", wordToneClassName)} />
              ) : row.phase === "done" ? (
                <CheckIcon className={cn("size-3 shrink-0", wordToneClassName)} />
              ) : null}
              <span className={cn("shrink-0", wordToneClassName)}>{description.word}</span>
              {description.detail?.kind === "action" ? (
                <ActionText action={description.detail.action} />
              ) : null}
              {description.durationLabel ? (
                <>
                  <Separator />
                  <span className="shrink-0 tabular-nums">{description.durationLabel}</span>
                </>
              ) : null}
              {description.detail?.kind === "outcome" ? (
                <span className="min-w-0 truncate">
                  <span aria-hidden="true">→ </span>
                  {renderInlineCode(description.detail.text)}
                </span>
              ) : null}
              {description.detail?.kind === "was-running" ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">→ was running</span>
                  <ActionText action={description.detail.action} />
                </span>
              ) : null}
            </span>
          </span>
        </button>
        {row.nested.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground/70"
            aria-expanded={nestedOpen}
            onClick={() => setNestedOpen((open) => !open)}
          >
            {`launched ${row.nested.length} ${pluralize(row.nested.length, "subagent")}`}
            <DisclosureChevron open={nestedOpen} className="size-3" />
          </Button>
        ) : null}
        {live && openThread ? (
          // Message reveals on hover or keyboard focus; it stays in the tab order.
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0 opacity-0 transition-opacity group-hover/subagent-row:opacity-100 group-focus-within/subagent-row:opacity-100 focus-visible:opacity-100"
            onClick={openThread}
          >
            <ChatBubbleIcon className="size-3" />
            Message
          </Button>
        ) : null}
        {live && depth === 0 && !row.item.isBackground && onBackground ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 transition-opacity group-hover/subagent-row:opacity-100 group-focus-within/subagent-row:opacity-100 focus-visible:opacity-100"
            onClick={() => void onBackground(row.item)}
            aria-label="Run in background (ctrl+b)"
            title="Run in background (ctrl+b)"
          >
            <BackgroundTrayIcon className="size-3" />
          </Button>
        ) : null}
        {live && onStop ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={() => void onStop(row.item)}
            aria-label={`Stop ${row.item.primaryLabel}`}
          >
            <StopIcon className="size-2.5" />
            Stop
          </Button>
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 text-muted-foreground/45", !openThread && "invisible")}
        />
      </div>
      {row.nested.length > 0 ? (
        <DisclosureRegion open={nestedOpen}>
          <div className="ml-[0.6rem] border-l border-[color:var(--color-border-light)] pl-2">
            {row.nested.map((nestedRow) => (
              <SubagentRunRowView
                key={nestedRow.key}
                row={nestedRow}
                nowMs={nowMs}
                allStopped={allStopped}
                depth={depth + 1}
                context={context}
              />
            ))}
          </div>
        </DisclosureRegion>
      ) : null}
    </div>
  );
}

function collectThreadIds(rows: ReadonlyArray<SubagentRunRow>): string[] {
  return rows.flatMap((row) => [
    ...(row.threadId ? [row.threadId as string] : []),
    ...collectThreadIds(row.nested),
  ]);
}

export function SubagentRunCard({ workEntry }: { workEntry: WorkLogEntry }) {
  const context = useSubagentRunContext();
  const threads = context?.threads ?? EMPTY_THREADS;
  const parentThreadId = context?.parentThreadId ?? null;
  const backgrounded = context?.backgroundedProviderThreadIds ?? EMPTY_IDS;
  const launchTurnLive = context ? isLaunchTurnLive(workEntry, context.liveTurnId) : true;
  const taskEnds = context?.taskEndByToolUseId ?? EMPTY_TASK_ENDS;
  const card = useMemo(
    () =>
      deriveSubagentRunCard({
        subagents: workEntry.subagents ?? [],
        run: workEntry.subagentRun ?? { members: [] },
        threads,
        parentThreadId,
        backgroundedProviderThreadIds: backgrounded,
        launchTurnLive,
        taskEndByToolUseId: taskEnds,
      }),
    [
      backgrounded,
      launchTurnLive,
      parentThreadId,
      taskEnds,
      threads,
      workEntry.subagentRun,
      workEntry.subagents,
    ],
  );
  // Elapsed clocks tick locally so the transcript does not re-render each second.
  const nowMs = useNowMs(card.isLive);
  // Open while any subagent works, and it stays open once seen live, so a run
  // that ends mid-turn does not collapse under the reader; a finished run met
  // in history starts folded into one row.
  const [seenLive, setSeenLive] = useState(card.isLive);
  useEffect(() => {
    if (card.isLive) setSeenLive(true);
  }, [card.isLive]);
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? (card.isLive || seenLive);
  const header = describeSubagentRunHeader(card, nowMs);
  const liveItems = collectLiveSubagentRunItems(card.rows);
  const onStop = context?.onStop;

  // Finished rows read their result from the child thread, which may not be
  // loaded yet; hold its detail while the card is open.
  const threadIdsKey = expanded ? collectThreadIds(card.rows).toSorted().join("\n") : "";
  useEffect(() => {
    if (!threadIdsKey) return;
    const releases = threadIdsKey
      .split("\n")
      .map((threadId) => retainThreadDetailSubscription(ThreadId.makeUnsafe(threadId)));
    return () => {
      for (const release of releases) release();
    };
  }, [threadIdsKey]);

  // Report whether the card is on screen so the floating "N running" chip only
  // shows while it is not.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visibility = context?.visibility ?? null;
  const entryId = workEntry.id;
  useEffect(() => {
    const element = rootRef.current;
    if (!element || !visibility || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((observed) => {
      const last = observed.at(-1);
      if (!last) return;
      const viewportTop = last.rootBounds?.top ?? 0;
      visibility.set(
        entryId,
        last.isIntersecting
          ? "visible"
          : last.boundingClientRect.bottom <= viewportTop
            ? "above"
            : "below",
      );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      visibility.set(entryId, null);
    };
  }, [entryId, visibility]);

  const HeaderIcon = card.isLive
    ? null
    : card.counts.failed > 0
      ? CircleAlertIcon
      : card.allStopped
        ? null
        : CircleCheckIcon;

  return (
    <div
      ref={rootRef}
      data-testid="subagent-run-card"
      data-subagent-run-card={entryId}
      data-expanded={expanded || undefined}
      className={cn(
        "my-0.5 rounded-xl border text-ui transition-colors motion-reduce:transition-none",
        expanded
          ? "border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)]"
          : "border-transparent",
      )}
    >
      <div className={cn("flex min-w-0 items-center gap-1", expanded ? "px-2.5 py-1.5" : "py-0.5")}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={() => setExpandedChoice(!expanded)}
        >
          {card.isLive ? (
            <LiveStatusSpinner className="size-3.5 shrink-0 text-muted-foreground" />
          ) : HeaderIcon ? (
            <HeaderIcon
              className={cn(
                "size-3.5 shrink-0",
                card.counts.failed > 0
                  ? "text-muted-foreground"
                  : "text-emerald-600 dark:text-emerald-300/85",
              )}
            />
          ) : (
            <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
              <span className="size-2 rounded-[2px] bg-muted-foreground/70" />
            </span>
          )}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span className="font-medium text-foreground/88">{header.title}</span>
            {header.nestedLabel ? (
              <span className="rounded-md bg-[var(--color-background-button-secondary)] px-1.5 text-ui-sm text-muted-foreground/75">
                {header.nestedLabel}
              </span>
            ) : null}
            {header.segments.map((segment) => (
              <Fragment key={segment.text}>
                <Separator />
                <span
                  className={cn(
                    "text-muted-foreground/75",
                    segment.tone === "running" && subagentStatusTextToneClassName("running"),
                    segment.tone === "failed" && subagentStatusTextToneClassName("failed"),
                  )}
                >
                  {segment.text}
                </span>
              </Fragment>
            ))}
            {header.durationLabel ? (
              <>
                <Separator />
                <span className="tabular-nums text-muted-foreground/75">
                  {header.durationLabel}
                </span>
              </>
            ) : null}
          </span>
          {expanded ? null : <DisclosureChevron open={false} className="text-muted-foreground/55" />}
        </button>
        {card.isLive && liveItems.length > 0 && onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => void Promise.all(liveItems.map((item) => onStop(item)))}
          >
            <StopIcon className="size-2.5" />
            Stop all
          </Button>
        ) : null}
        {expanded ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label="Collapse subagents"
            onClick={() => setExpandedChoice(false)}
          >
            <ChevronRightIcon className="size-3.5 -rotate-90 text-muted-foreground" />
          </Button>
        ) : null}
      </div>
      <DisclosureRegion open={expanded}>
        <div className="border-t border-[color:var(--color-border-light)] px-1 py-1">
          {card.rows.map((row) => (
            <SubagentRunRowView
              key={row.key}
              row={row}
              nowMs={nowMs}
              allStopped={card.allStopped}
              depth={0}
              context={context}
            />
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
}
