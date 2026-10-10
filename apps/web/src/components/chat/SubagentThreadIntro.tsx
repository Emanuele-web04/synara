// FILE: SubagentThreadIntro.tsx
// Purpose: Context for a subagent's own thread: a centered "Subagent of
// <parent>" pill (opens the parent) with a role · model · state line, the
// brief from the launching agent as a bordered card instead of a user bubble,
// and the "Delivered to <parent>" note on the answer that went back.
// Layer: Chat transcript UI
// Exports: SubagentThreadIntro, SubagentBriefCard, SubagentDeliveredNote,
// SubagentThreadPresentation

import type { ProviderKind, ThreadId } from "@synara/contracts";
import type { CSSProperties } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import { ArrowUpRightIcon, BackToParentIcon, BotIcon } from "~/lib/icons";
import {
  subagentOutcomeTextToneClassName,
  type SubagentStatusKind,
} from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { formatClockDuration } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderIcon } from "../ProviderIcon";

export interface SubagentThreadPresentation {
  parentThreadId: ThreadId;
  parentTitle: string;
  role: string | null;
  modelLabel: string | null;
  provider: ProviderKind | null;
  statusKind: SubagentStatusKind | null;
  startedAt: string | null;
  endedAt: string | null;
}

function durationMs(startedAt: string | null, endedAt: string | null, nowMs: number) {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : nowMs;
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start;
}

// "Running · 12s", "Done in 8s", "Failed after 3s", "Stopped after 4s".
export function subagentThreadStateLabel(
  statusKind: SubagentStatusKind | null,
  elapsedMs: number | null,
): string | null {
  const elapsed = elapsedMs === null ? null : formatClockDuration(elapsedMs);
  switch (statusKind) {
    case "running":
      return elapsed ? `Running · ${elapsed}` : "Running";
    case "queued":
      return "Starting";
    case "completed":
      return elapsed ? `Done in ${elapsed}` : "Done";
    case "failed":
      return elapsed ? `Failed after ${elapsed}` : "Failed";
    case "stopped":
      return elapsed ? `Stopped after ${elapsed}` : "Stopped";
    default:
      return null;
  }
}

export function SubagentThreadIntro({
  subagent,
  onOpenThread,
}: {
  subagent: SubagentThreadPresentation;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const live = subagent.statusKind === "running";
  const nowMs = useNowMs(live);
  const stateLabel = subagentThreadStateLabel(
    subagent.statusKind,
    live || subagent.endedAt
      ? durationMs(subagent.startedAt, live ? null : subagent.endedAt, nowMs)
      : null,
  );
  return (
    <div
      data-testid="subagent-thread-intro"
      className="flex flex-col items-center gap-1.5 pt-2 pb-4 font-system-ui text-ui-sm"
    >
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[color:var(--color-border)] px-3 py-1 text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
        onClick={() => onOpenThread?.(subagent.parentThreadId)}
        disabled={!onOpenThread}
        aria-label={`Open parent thread ${subagent.parentTitle}`}
      >
        <BackToParentIcon className="size-3 shrink-0" />
        <span className="shrink-0">Subagent of</span>
        <span className="min-w-0 truncate font-medium text-foreground/85">
          {subagent.parentTitle}
        </span>
        <ArrowUpRightIcon className="size-3 shrink-0" />
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/75">
        {subagent.role ? <span>{subagent.role}</span> : null}
        {subagent.role && subagent.modelLabel ? <span aria-hidden="true">·</span> : null}
        {subagent.modelLabel ? (
          <span className="inline-flex items-center gap-1">
            {subagent.provider ? (
              <ProviderIcon provider={subagent.provider} className="size-3" />
            ) : null}
            {subagent.modelLabel}
          </span>
        ) : null}
        {stateLabel && (subagent.role || subagent.modelLabel) ? (
          <span aria-hidden="true">·</span>
        ) : null}
        {stateLabel ? (
          <span
            className={cn("tabular-nums", subagentOutcomeTextToneClassName(subagent.statusKind))}
          >
            {stateLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function SubagentBriefCard({
  parentTitle,
  text,
  timestamp,
  markdownCwd,
  textStyle,
}: {
  parentTitle: string;
  text: string;
  timestamp: string | null;
  markdownCwd: string | undefined;
  textStyle?: CSSProperties | undefined;
}) {
  return (
    <div
      data-testid="subagent-brief-card"
      className="w-full rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3.5 py-2.5"
    >
      <div className="mb-1 flex min-w-0 items-center gap-1.5 font-system-ui text-ui-sm text-muted-foreground">
        <BotIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Brief from</span>
        <span className="min-w-0 truncate font-medium text-foreground/80">{parentTitle}</span>
        {timestamp ? <span className="ml-auto shrink-0 tabular-nums">{timestamp}</span> : null}
      </div>
      <ChatMarkdown text={text} cwd={markdownCwd} isStreaming={false} style={textStyle} />
    </div>
  );
}

export function SubagentDeliveredNote({ parentTitle }: { parentTitle: string }) {
  return (
    <span
      data-testid="subagent-delivered-note"
      className="ml-auto inline-flex min-w-0 items-center gap-1.5"
      title={`This answer went back to ${parentTitle}`}
    >
      <BackToParentIcon className="size-3 shrink-0" />
      <span className="truncate">Delivered to {parentTitle}</span>
    </span>
  );
}
