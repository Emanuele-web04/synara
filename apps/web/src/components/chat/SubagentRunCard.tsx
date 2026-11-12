// FILE: SubagentRunCard.tsx
// Purpose: The transcript row a turn's subagents fold into, at the point the
// parent launched them. It reads like a tool row: the subagents' avatars and
// "Created 2 subagents · 1 running · 12s" (Stop all while live), with one
// unboxed line per subagent underneath (avatar, name, role, model, live state
// with the current command, or the past-tense outcome with a one-line result).
// Nested subagents sit collapsed under the row that launched them. The row
// starts collapsed and expands on click.
// Layer: Chat transcript UI
// Exports: SubagentRunCard, SubagentIdentityLine

import { ThreadId } from "@synara/contracts";
import { pluralize } from "~/i18n/pluralize";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import { BackgroundTrayIcon, ChatBubbleIcon, ChevronRightIcon, StopIcon } from "~/lib/icons";
import { subagentStatusTextToneClassName } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { retainThreadDetailSubscription } from "../../threadDetailSubscriptionRetention";
import type { WorkLogEntry } from "../../session-logic";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
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
import { SubagentAvatar, SubagentAvatarStack } from "./SubagentAvatar";
import { useSubagentRunContext, type SubagentRunContextValue } from "./subagentRunContext";
import { useTranslation } from "~/i18n";

const EMPTY_THREADS: SubagentRunContextValue["threads"] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_TASK_ENDS: SubagentRunContextValue["taskEndByToolUseId"] = new Map();
// Avatars in the header before the rest collapse into "+N".
const HEADER_AVATAR_LIMIT = 3;

/** Name, role, and model of one subagent: the identity line every row shares. */
export function SubagentIdentityLine({ item }: { item: ComposerSubagentStripItem }) {
  const { t } = useTranslation();

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
        <span className="shrink-0 text-ui-sm text-muted-foreground/48">{t("chat:background")}</span>
      ) : null}
    </span>
  );
}

// A one-line result reads as plain text, like the rest of the row: backticks
// from the subagent's Markdown are dropped rather than rendered as code.
function plainPreview(text: string): string {
  return text.replaceAll("`", "");
}

function ActionText({ action }: { action: SubagentRunAction }) {
  return <span className="min-w-0 truncate">{action.command ?? action.label}</span>;
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
  const { t } = useTranslation();

  const [nestedOpen, setNestedOpen] = useState(false);
  const description = describeSubagentRunRow(row, { nowMs, allStopped });
  const live = row.phase === "running" || row.phase === "waiting" || row.phase === "starting";
  const { threadId } = row;
  const openThread = threadId && context ? () => context.onOpenThread(threadId) : undefined;
  const onStop = context?.onStop;
  const onBackground = context?.onBackground;
  // One color in the row: the live spinner. Outcomes stay muted except failures.
  const wordToneClassName =
    description.statusKind === "failed"
      ? subagentStatusTextToneClassName("failed")
      : "text-muted-foreground/70";

  return (
    <div data-testid="subagent-run-row" data-phase={row.phase} data-depth={depth}>
      <div className="group/subagent-row relative flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-0.5 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-within:bg-[var(--color-background-button-secondary-hover)] [&>button:not(:first-child)]:relative [&>button:not(:first-child)]:z-[1]">
        {/* The open button stretches over the whole row (chevron included);
            the row's own controls sit above it. */}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-1 focus-visible:after:ring-ring/60 disabled:cursor-default"
          disabled={!openThread}
          onClick={openThread}
          aria-label={t("workspace:open", { value0: row.item.primaryLabel })}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <SubagentAvatar
              seed={row.item.key}
              accentColor={row.item.accentColor}
              className="size-3.5"
            />
            <SubagentIdentityLine item={row.item} />
            <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground/70">
              {/* The avatar leads the row; a live word shimmers like the header count. */}
              <span className={cn("shrink-0", wordToneClassName, live && "shimmer")}>
                {description.word}
              </span>
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
                  {plainPreview(description.detail.text)}
                </span>
              ) : null}
              {description.detail?.kind === "was-running" ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">{t("chat:wasRunning")}</span>
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
            {t("chat:launched", {
              value0: row.nested.length,
              value1: pluralize(row.nested.length, "subagent"),
            })}
            <DisclosureChevron open={nestedOpen} className="size-3" />
          </Button>
        ) : null}
        {live && openThread ? (
          // Message reveals on hover or keyboard focus; it stays in the tab order.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 opacity-0 transition-opacity group-hover/subagent-row:opacity-100 group-focus-within/subagent-row:opacity-100 focus-visible:opacity-100"
            onClick={openThread}
          >
            <ChatBubbleIcon className="size-3" />
            {t("chat:message")}
          </Button>
        ) : null}
        {live && depth === 0 && !row.item.isBackground && onBackground ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 transition-opacity group-hover/subagent-row:opacity-100 group-focus-within/subagent-row:opacity-100 focus-visible:opacity-100"
            onClick={() => void onBackground(row.item)}
            aria-label={t("chat:runInBackgroundCtrlB")}
            title={t("chat:runInBackgroundCtrlB")}
          >
            <BackgroundTrayIcon className="size-3" />
          </Button>
        ) : null}
        {live && onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => void onStop(row.item)}
            aria-label={t("chat:stop2", { value0: row.item.primaryLabel })}
          >
            <StopIcon className="size-2.5" />
            {t("chat:stop")}
          </Button>
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/45 opacity-0 transition-opacity group-hover/subagent-row:opacity-100 group-focus-within/subagent-row:opacity-100",
            !openThread && "invisible",
          )}
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

export function SubagentRunCard({
  workEntry,
  fontSizePx,
}: {
  workEntry: WorkLogEntry;
  /** The transcript's tool-row size, so the row matches the tool rows around it. */
  fontSizePx?: number;
}) {
  const { t } = useTranslation();

  const context = useSubagentRunContext();
  const threads = context?.threads ?? EMPTY_THREADS;
  const parentThreadId = context?.parentThreadId ?? null;
  const backgrounded = context?.backgroundedProviderThreadIds ?? EMPTY_IDS;
  const launchTurnLive = context ? isLaunchTurnLive(workEntry, context.liveTurnId) : true;
  const taskEnds = context?.taskEndByToolUseId ?? EMPTY_TASK_ENDS;
  const runtimeRetired = context?.runtimeRetired === true;
  const card = useMemo(
    () =>
      deriveSubagentRunCard({
        translate: t,
        subagents: workEntry.subagents ?? [],
        run: workEntry.subagentRun ?? { members: [] },
        threads,
        parentThreadId,
        backgroundedProviderThreadIds: backgrounded,
        launchTurnLive,
        taskEndByToolUseId: taskEnds,
        runtimeRetired,
      }),
    [
      t,
      backgrounded,
      launchTurnLive,
      parentThreadId,
      runtimeRetired,
      taskEnds,
      threads,
      workEntry.subagentRun,
      workEntry.subagents,
    ],
  );
  // Elapsed clocks tick locally so the transcript does not re-render each second.
  const nowMs = useNowMs(card.isLive);
  const [expanded, setExpandedChoice] = useState(false);
  const header = describeSubagentRunHeader(card, nowMs, t);
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
  const visibilityIdsKey = (workEntry.subagentRun?.entryIds ?? [entryId]).join("\n");
  useEffect(() => {
    const element = rootRef.current;
    if (!element || !visibility || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (observed) => {
        const last = observed.at(-1);
        if (!last) return;
        const viewportTop = last.rootBounds?.top ?? 0;
        for (const id of visibilityIdsKey.split("\n"))
          visibility.set(
            id,
            last.isIntersecting
              ? "visible"
              : last.boundingClientRect.bottom <= viewportTop
                ? "above"
                : "below",
          );
      },
      { root: element.closest('[data-chat-scroll-container="true"]') },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      for (const id of visibilityIdsKey.split("\n")) visibility.set(id, null);
    };
  }, [visibilityIdsKey, visibility]);

  const avatars = card.rows.slice(0, HEADER_AVATAR_LIMIT).map((row) => row.item);
  const hiddenAvatarCount = card.rows.length - avatars.length;

  return (
    <div
      ref={rootRef}
      data-testid="subagent-run-card"
      data-subagent-run-card={entryId}
      data-live={card.isLive || undefined}
      data-expanded={expanded || undefined}
      className={cn(fontSizePx === undefined && "text-ui")}
      style={fontSizePx === undefined ? undefined : { fontSize: `${fontSizePx}px` }}
    >
      <div className="flex min-w-0 items-center gap-1">
        {/* The same muted line as a tool row: the launch reads as one action,
            not a status card. Liveness rides on the shimmering count. */}
        <button
          type="button"
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left leading-5 transition-colors duration-200 hover:text-foreground",
            MUTED_LABEL_TEXT_CLASS_NAME,
          )}
          aria-expanded={expanded}
          onClick={() => setExpandedChoice(!expanded)}
        >
          <span className="flex shrink-0 items-center gap-1" data-subagent-run-avatars="true">
            <SubagentAvatarStack items={avatars} className="[&>svg]:size-3.5" />
            {hiddenAvatarCount > 0 ? (
              <span className="text-ui-xs tabular-nums">+{hiddenAvatarCount}</span>
            ) : null}
          </span>
          <span className="min-w-0 truncate">
            <span>{header.title}</span>
            {header.subject ? <span className="text-foreground/80"> {header.subject}</span> : null}
            {header.nestedLabel ? <span> ({header.nestedLabel})</span> : null}
            {header.segments.map((segment) => (
              <Fragment key={segment.text}>
                <span aria-hidden="true"> · </span>
                <span
                  className={cn(
                    segment.tone === "running" && "shimmer",
                    segment.tone === "failed" && subagentStatusTextToneClassName("failed"),
                  )}
                  data-subagent-run-segment={segment.tone ?? undefined}
                >
                  {segment.text}
                </span>
              </Fragment>
            ))}
            {header.durationLabel ? (
              <span className="tabular-nums">
                <span aria-hidden="true"> · </span>
                {header.durationLabel}
              </span>
            ) : null}
          </span>
          <DisclosureChevron open={expanded} className="text-muted-foreground/70" />
        </button>
        {card.isLive && liveItems.length > 0 && onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-foreground/80"
            onClick={() => void Promise.all(liveItems.map((item) => onStop(item)))}
          >
            <StopIcon className="size-2.5" />
            {t("chat:stopAll")}
          </Button>
        ) : null}
      </div>
      <DisclosureRegion open={expanded}>
        {/* Rows hang unboxed under the header, their avatars in its avatar column. */}
        <div className="-mx-1.5 pt-0.5 pb-0.5">
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
