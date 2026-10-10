// FILE: SubagentsDockPane.tsx
// Purpose: Right-dock list of every subagent the host thread spawned (opened from the
//          Environment panel summary). "Active" rows show what each run is doing with a
//          ticking time and stop/background on hover; "Done" rows show when they finished,
//          with totals and the result in the tooltip. From a subagent thread it lists the
//          siblings plus a row back to the parent. Selecting a row opens that thread and
//          keeps this list beside it.
// Layer: Chat right-dock UI
// Exports: SubagentsDockPane, SubagentsList (the presentational list it renders)

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import { useNowMs } from "~/hooks/useNowMs";
import { BackgroundTrayIcon, BackToParentIcon, StopIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { subagentStatusTextToneClassName } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { useRightDockStore } from "~/rightDockStore";

import { formatClockDuration } from "../../session-logic";
import { ENVIRONMENT_ROW_ICON_CLASS_NAME, EnvironmentRow } from "./environment/EnvironmentRow";
import {
  environmentSubagentElapsedMs,
  formatEnvironmentSubagentMeta,
  type EnvironmentSubagentRoster,
  type EnvironmentSubagentRosterItem,
} from "./environment/EnvironmentSubagentsSection.logic";
import { PanelStateMessage } from "./PanelStateMessage";
import { SubagentAvatar } from "./SubagentAvatar";
import { useSubagentRunControls } from "./useSubagentRunControls";
import { type SubagentParentRow, useThreadSubagentRoster } from "./useSubagentStripSource";

// Done rows shown before "Show more"; active rows always render.
const DONE_VISIBLE_LIMIT = 10;
const SUMMARY_TOOLTIP_MAX_CHARS = 280;
const SECONDARY_TEXT_CLASS_NAME = "text-[var(--color-text-foreground-secondary)]";

function rowTooltip(item: EnvironmentSubagentRosterItem): string {
  const summary =
    item.summary && item.summary.length > SUMMARY_TOOLTIP_MAX_CHARS
      ? `${item.summary.slice(0, SUMMARY_TOOLTIP_MAX_CHARS - 1)}…`
      : item.summary;
  const stats = formatEnvironmentSubagentMeta(item);
  return [[item.fullLabel, item.modelLabel].filter(Boolean).join(" · "), stats, summary]
    .filter(Boolean)
    .join("\n\n");
}

function finishedAgoLabel(item: EnvironmentSubagentRosterItem): string | null {
  const at = item.settledAt ?? item.startedAt;
  if (!at) return null;
  const relative = formatRelativeTime(at);
  return relative === "now" ? "just now" : `${relative} ago`;
}

function ListHeading({ label, count }: { label: string; count: number }) {
  return (
    <p className={cn("px-2 pt-3 pb-1 text-ui-sm first:pt-0", SECONDARY_TEXT_CLASS_NAME)}>
      {label} · {count}
    </p>
  );
}

function ActiveSubagentRow({
  item,
  nowMs,
  onOpen,
  onBackground,
  onStop,
}: {
  item: EnvironmentSubagentRosterItem;
  nowMs: number;
  onOpen: (threadId: ThreadId) => void;
  onBackground: (item: EnvironmentSubagentRosterItem) => void;
  onStop: (item: EnvironmentSubagentRosterItem) => void;
}) {
  const elapsedMs = environmentSubagentElapsedMs(item, nowMs);
  const meta = formatEnvironmentSubagentMeta(item);
  const showBackground = item.isActive && !item.isBackground;
  const showStop = item.isActive;
  const actionCount = Number(showBackground) + Number(showStop);

  // The actions overlay the first line instead of nesting inside the row (a button cannot
  // contain a button); on hover the time gives way to a spacer that reserves their slot.
  return (
    <div className="group/subagent relative">
      <EnvironmentRow
        compact
        icon={<SubagentAvatar seed={item.key} accentColor={item.accentColor} className="size-5" />}
        label={
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{item.primaryLabel}</span>
              {elapsedMs !== null ? (
                <span
                  className={cn(
                    "shrink-0 text-ui-sm tabular-nums",
                    SECONDARY_TEXT_CLASS_NAME,
                    actionCount > 0 &&
                      "group-focus-within/subagent:hidden group-hover/subagent:hidden",
                  )}
                >
                  {formatClockDuration(elapsedMs)}
                </span>
              ) : null}
              {actionCount > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    "hidden shrink-0 group-focus-within/subagent:block group-hover/subagent:block",
                    actionCount === 2 ? "w-12" : "w-6",
                  )}
                />
              ) : null}
            </span>
            <span className={cn("truncate text-ui-sm", SECONDARY_TEXT_CLASS_NAME)}>
              <span className={subagentStatusTextToneClassName(item.statusKind)}>
                {item.statusLabel ?? "Running"}
              </span>
              {meta ? ` · ${meta}` : null}
            </span>
          </span>
        }
        className={cn(
          "items-start",
          item.isViewed && "bg-[var(--color-background-elevated-secondary)]",
        )}
        title={rowTooltip(item)}
        aria-label={`Open subagent ${item.fullLabel}${item.statusLabel ? ` (${item.statusLabel})` : ""}`}
        aria-current={item.isViewed ? "page" : undefined}
        data-testid="subagents-pane-active-row"
        onClick={() => onOpen(item.threadId)}
      />
      {actionCount > 0 ? (
        <div className="absolute top-0.5 right-2 flex items-center opacity-0 transition-opacity group-focus-within/subagent:opacity-100 group-hover/subagent:opacity-100">
          {showBackground ? (
            <IconButton
              label={`Run ${item.primaryLabel} in background`}
              tooltip="Run in background (ctrl+b)"
              onClick={() => onBackground(item)}
            >
              <BackgroundTrayIcon className="size-3.5" />
            </IconButton>
          ) : null}
          {showStop ? (
            <IconButton
              label={`Stop subagent ${item.primaryLabel}`}
              tooltip="Stop subagent"
              onClick={() => onStop(item)}
            >
              <StopIcon className="size-3.5" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DoneSubagentRow({
  item,
  onOpen,
}: {
  item: EnvironmentSubagentRosterItem;
  onOpen: (threadId: ThreadId) => void;
}) {
  // A finished run reads as done; only failures and stops name their outcome.
  const outcome = item.statusKind === "completed" ? null : item.statusLabel;
  const finishedAgo = finishedAgoLabel(item);
  return (
    <EnvironmentRow
      compact
      icon={<SubagentAvatar seed={item.key} accentColor={item.accentColor} className="size-5" />}
      label={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">{item.primaryLabel}</span>
          {outcome ? (
            <span
              className={cn(
                "shrink-0 text-ui-sm",
                subagentStatusTextToneClassName(item.statusKind),
              )}
            >
              {outcome}
            </span>
          ) : null}
        </span>
      }
      trailing={
        finishedAgo ? (
          <span className={cn("text-ui-sm", SECONDARY_TEXT_CLASS_NAME)}>{finishedAgo}</span>
        ) : null
      }
      className={cn(item.isViewed && "bg-[var(--color-background-elevated-secondary)]")}
      title={rowTooltip(item)}
      aria-label={`Open subagent ${item.fullLabel}${item.statusLabel ? ` (${item.statusLabel})` : ""}`}
      aria-current={item.isViewed ? "page" : undefined}
      data-testid="subagents-pane-done-row"
      onClick={() => onOpen(item.threadId)}
    />
  );
}

export function SubagentsList({
  roster,
  parent,
  nowMs,
  onOpen,
  onBackground,
  onStop,
}: {
  roster: EnvironmentSubagentRoster;
  parent: SubagentParentRow | null;
  nowMs: number;
  onOpen: (threadId: ThreadId) => void;
  onBackground: (item: EnvironmentSubagentRosterItem) => void;
  onStop: (item: EnvironmentSubagentRosterItem) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);
  const { active, previous } = roster;
  if (active.length === 0 && previous.length === 0) {
    return <PanelStateMessage>No subagents in this chat yet.</PanelStateMessage>;
  }

  const hiddenDoneCount = showAllDone ? 0 : Math.max(0, previous.length - DONE_VISIBLE_LIMIT);
  const visibleDone = hiddenDoneCount > 0 ? previous.slice(0, DONE_VISIBLE_LIMIT) : previous;

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col gap-0.5 overflow-y-auto px-3 py-4"
      data-testid="subagents-dock-pane"
    >
      {parent ? (
        <EnvironmentRow
          icon={<BackToParentIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={<span className="truncate">{parent.label ?? "Main thread"}</span>}
          aria-label={`Back to ${parent.label ?? "main thread"}`}
          className="mb-2"
          onClick={() => onOpen(parent.threadId)}
        />
      ) : null}
      {active.length > 0 ? (
        <>
          <ListHeading label="Active" count={active.length} />
          {active.map((item) => (
            <ActiveSubagentRow
              key={item.key}
              item={item}
              nowMs={nowMs}
              onOpen={onOpen}
              onBackground={onBackground}
              onStop={onStop}
            />
          ))}
        </>
      ) : null}
      {previous.length > 0 ? (
        <>
          <ListHeading label="Done" count={previous.length} />
          {visibleDone.map((item) => (
            <DoneSubagentRow key={item.key} item={item} onOpen={onOpen} />
          ))}
          {previous.length > DONE_VISIBLE_LIMIT ? (
            <EnvironmentRow
              compact
              icon={<span aria-hidden className="size-5 shrink-0" />}
              label={
                <span className={SECONDARY_TEXT_CLASS_NAME}>
                  {hiddenDoneCount > 0 ? `Show ${hiddenDoneCount} more` : "Show less"}
                </span>
              }
              aria-expanded={hiddenDoneCount === 0}
              onClick={() => setShowAllDone((value) => !value)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function SubagentsDockPane({ hostThreadId }: { hostThreadId: ThreadId }) {
  const { roster, source } = useThreadSubagentRoster(hostThreadId);
  const { backgroundSubagent, stopSubagent } = useSubagentRunControls(source.stripSourceThreadId);
  const navigate = useNavigate();
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  const nowMs = useNowMs(roster.active.length > 0);

  // Docks are per thread: open this list in the destination's dock too, so hopping
  // between siblings (or back to the parent) keeps it beside the transcript.
  const openThread = (threadId: ThreadId) => {
    openRightDockPane(threadId, { kind: "subagents" });
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previousSearch) => stripDiffSearchParams(previousSearch),
    });
  };

  return (
    <SubagentsList
      roster={roster}
      parent={source.subagentParentRow}
      nowMs={nowMs}
      onOpen={openThread}
      onBackground={(item) => void backgroundSubagent(item)}
      onStop={(item) => void stopSubagent(item)}
    />
  );
}
