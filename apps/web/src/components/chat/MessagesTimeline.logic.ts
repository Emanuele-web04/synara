// FILE: MessagesTimeline.logic.ts
// Purpose: Owns the pure row-derivation helpers used by the transcript hot path.
// Layer: Web chat presentation helpers
// Exports: row derivation, structural sharing, copy/timer helpers

import {
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type TurnId,
} from "@synara/contracts";
import { isProviderKind } from "../../providerOrdering";
import { type TimelineEntry, type WorkLogEntry, formatElapsed } from "../../session-logic";
import type { WorkLogUserInputExchangeItem } from "../../workLog";
import { normalizeCompactToolLabel as normalizeCompactToolLabelValue } from "../../lib/toolCallLabel";
import { isCodexActivityStatusWorkEntry } from "./agentActivity.logic";
import {
  isSummarizableToolCallEntry,
  MIN_COLLAPSIBLE_TOOL_GROUP_SIZE,
  summarizeToolCallGroup,
  workEntryRowCount,
  type ToolCallGroupSummary,
} from "./toolCallGroup.logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type TurnDiffSummary,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStep,
} from "../../types";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

// A "Show N more" toggle costs a row of its own, so hiding one or two rows
// behind it saves nothing and only hides work. Lists collapse only when the
// toggle would hide at least this many rows.
export const MIN_HIDDEN_ROWS_TO_COLLAPSE = 3;

// How many of `total` rows a list capped at `maxVisible` hides, or 0 when the
// cap would hide too few rows to be worth a toggle.
export function collapsibleHiddenRowCount(total: number, maxVisible: number): number {
  const hidden = Math.max(0, total - Math.max(0, maxVisible));
  return hidden >= MIN_HIDDEN_ROWS_TO_COLLAPSE ? hidden : 0;
}

export function canSubmitUserMessageEdit(input: {
  draft: string;
  allowEmpty: boolean;
  disabled: boolean;
}): boolean {
  return (input.allowEmpty || input.draft.trim().length > 0) && !input.disabled;
}

// Ordered item folded into a settled turn's single turn header disclosure.
// A turn can interleave tool work and intermediate assistant narration
// (preambles), so the collapsed panel keeps both in chronological order.
export type CollapsedTurnItem =
  | { kind: "work"; id: string; entry: WorkLogEntry }
  | { kind: "narration"; id: string; message: ChatMessage };

// A settled turn's collapsed items re-chunked for rendering: consecutive
// summarizable tool rows fold into one "Ran N commands..." disclosure while
// narration and rich rows pass through individually.
export type CollapsedTurnChunk =
  | { kind: "item"; item: CollapsedTurnItem }
  | { kind: "tool-group"; id: string; entries: WorkLogEntry[] }
  | { kind: "background-group"; id: string; entries: WorkLogEntry[] };

export type WorkEntryChunk =
  | { kind: "item"; id: string; entry: WorkLogEntry }
  | { kind: "tool-group"; id: string; entries: WorkLogEntry[] }
  | { kind: "background-group"; id: string; entries: WorkLogEntry[] };

// A cascade of background task rows reads as noise past a couple; three or
// more in a row share one expandable line.
export const MIN_BACKGROUND_TASK_GROUP_SIZE = 3;

function isBackgroundTaskItem(
  item: CollapsedTurnItem,
): item is Extract<CollapsedTurnItem, { kind: "work" }> {
  return item.kind === "work" && item.entry.backgroundTask !== undefined;
}

// Splits runs of 3+ consecutive background task rows into their own group.
function groupBackgroundTaskRuns(chunks: ReadonlyArray<CollapsedTurnChunk>): CollapsedTurnChunk[] {
  const grouped: CollapsedTurnChunk[] = [];
  let run: Extract<CollapsedTurnItem, { kind: "work" }>[] = [];
  const flushRun = () => {
    if (run.length >= MIN_BACKGROUND_TASK_GROUP_SIZE) {
      grouped.push({
        kind: "background-group",
        id: run[0]!.id,
        entries: run.map((item) => item.entry),
      });
    } else {
      for (const item of run) grouped.push({ kind: "item", item });
    }
    run = [];
  };
  for (const chunk of chunks) {
    if (chunk.kind === "item" && isBackgroundTaskItem(chunk.item)) {
      run.push(chunk.item);
      continue;
    }
    flushRun();
    grouped.push(chunk);
  }
  flushRun();
  return grouped;
}

export function chunkCollapsedTurnItems(
  items: ReadonlyArray<CollapsedTurnItem>,
): CollapsedTurnChunk[] {
  const chunks: CollapsedTurnChunk[] = [];
  let pendingRun: Extract<CollapsedTurnItem, { kind: "work" }>[] = [];

  const flushPendingRun = () => {
    if (pendingRun.length === 0) return;
    const pendingRowCount = pendingRun.reduce(
      (total, item) => total + workEntryRowCount(item.entry),
      0,
    );
    if (pendingRowCount >= MIN_COLLAPSIBLE_TOOL_GROUP_SIZE) {
      chunks.push({
        kind: "tool-group",
        id: pendingRun[0]!.id,
        entries: pendingRun.map((item) => item.entry),
      });
    } else {
      for (const item of pendingRun) {
        chunks.push({ kind: "item", item });
      }
    }
    pendingRun = [];
  };

  for (const item of items) {
    if (item.kind === "work" && isSummarizableToolCallEntry(item.entry)) {
      pendingRun.push(item);
      continue;
    }
    flushPendingRun();
    chunks.push({ kind: "item", item });
  }
  flushPendingRun();
  return groupBackgroundTaskRuns(chunks);
}

export function chunkWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkEntryChunk[] {
  return chunkCollapsedTurnItems(
    entries.map((entry) => ({ kind: "work" as const, id: entry.id, entry })),
  ).map((chunk) => {
    if (chunk.kind === "tool-group" || chunk.kind === "background-group") return chunk;
    if (chunk.item.kind !== "work") {
      throw new Error("Work-entry chunking produced an unexpected narration item.");
    }
    return { kind: "item", id: chunk.item.id, entry: chunk.item.entry };
  });
}

// One renderable block of a work group: `summary` is non-null when the block
// renders collapsed behind a "Ran N commands..." disclosure. `liveEntry` is
// non-null while a tool run is still open: the run renders as one line wearing
// the latest status description, falling back to the newest call.
export interface WorkEntryRenderPlanChunk {
  id: string;
  entries: WorkLogEntry[];
  summary: ToolCallGroupSummary | null;
  liveEntry: WorkLogEntry | null;
  // Three or more background task rows sharing one expandable line.
  backgroundGroup?: boolean;
}

// Keep the latest activity description visible as technical calls arrive.
function pickLiveToolEntry(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry {
  return entries.findLast(isCodexActivityStatusWorkEntry) ?? entries.at(-1)!;
}

// Plans a work group's entries block by block. Boundaries are the entries a
// summary can never absorb — thinking/info narration, errors, rich cards — so
// each tool run between boundaries folds independently. A run stays expanded
// only while it still has running work, or while it is the trailing block of
// the live transcript tail (`tailIsLive`): the moment a new narration block
// starts after it, it stops being the tail and collapses mid-turn. An expanded
// run never lists its rows: it folds to a single line for its selected entry.
export function planWorkEntryRenderChunks(
  entries: ReadonlyArray<WorkLogEntry>,
  options: { tailIsLive: boolean },
): WorkEntryRenderPlanChunk[] {
  const chunks = chunkWorkEntries(entries);
  return chunks.map((chunk, index) => {
    if (chunk.kind === "item") {
      return { id: chunk.id, entries: [chunk.entry], summary: null, liveEntry: null };
    }
    if (chunk.kind === "background-group") {
      return {
        id: chunk.id,
        entries: chunk.entries,
        summary: null,
        liveEntry: null,
        backgroundGroup: true,
      };
    }
    const summary = summarizeToolCallGroup(chunk.entries);
    const isLiveTail = options.tailIsLive && index === chunks.length - 1;
    const collapsed = summary !== null && !summary.hasRunningEntry && !isLiveTail;
    return {
      id: chunk.id,
      entries: chunk.entries,
      summary: collapsed ? summary : null,
      liveEntry: summary !== null && !collapsed ? pickLiveToolEntry(chunk.entries) : null,
    };
  });
}

// A folded chunk renders as one line (settled summary or live newest call)
// instead of listing its rows.
export function isFoldedWorkEntryChunk(chunk: WorkEntryRenderPlanChunk): boolean {
  return chunk.summary !== null || chunk.liveEntry !== null || chunk.backgroundGroup === true;
}

// How a folded chunk renders: the line's summary, the rows its disclosure
// reveals, and a suffix for the open-state key. A live line reveals only the
// other entries, and keeps its own open state so the run
// settles collapsed even when the live line was opened.
export function resolveWorkEntryChunkFold(
  chunk: WorkEntryRenderPlanChunk,
): { summary: ToolCallGroupSummary; entries: WorkLogEntry[]; keySuffix: string } | null {
  if (chunk.summary !== null) {
    return { summary: chunk.summary, entries: chunk.entries, keySuffix: "" };
  }
  const liveSummary = chunk.liveEntry ? summarizeToolCallGroup(chunk.entries) : null;
  if (!liveSummary) return null;
  return {
    summary: liveSummary,
    // A multi-file edit wears a count ("Edited 9 files"), so its own file rows
    // still belong behind the line.
    entries: chunk.entries.filter(
      (entry) => entry !== chunk.liveEntry || workEntryRowCount(entry) > 1,
    ),
    keySuffix: ":live",
  };
}

export interface CappedWorkEntryRenderPlan {
  chunks: WorkEntryRenderPlanChunk[];
  hasOverflow: boolean;
  hiddenEntryCount: number;
}

// Keeps collapsed summaries intact while bounding only the entries that still
// render openly. Callers can exclude boundary/status rows from the budget when
// those rows are rendered separately from tool calls.
export function capOpenWorkEntryRenderChunks(
  chunks: ReadonlyArray<WorkEntryRenderPlanChunk>,
  options: {
    expanded: boolean;
    maxVisibleEntries: number;
    keep: "first" | "last";
    shouldCapEntry?: (entry: WorkLogEntry) => boolean;
  },
): CappedWorkEntryRenderPlan {
  const shouldCapEntry = options.shouldCapEntry ?? (() => true);
  const openEntries = chunks.flatMap((chunk) =>
    isFoldedWorkEntryChunk(chunk) ? [] : chunk.entries.filter(shouldCapEntry),
  );
  const maxVisibleEntries = Math.max(0, options.maxVisibleEntries);
  const hiddenEntryCount = collapsibleHiddenRowCount(openEntries.length, maxVisibleEntries);
  const hasOverflow = hiddenEntryCount > 0;

  if (!hasOverflow || options.expanded) {
    return { chunks: [...chunks], hasOverflow, hiddenEntryCount: 0 };
  }

  const visibleEntries =
    maxVisibleEntries === 0
      ? []
      : options.keep === "last"
        ? openEntries.slice(-maxVisibleEntries)
        : openEntries.slice(0, maxVisibleEntries);
  const visibleEntrySet = new Set(visibleEntries);

  return {
    chunks: chunks.map((chunk) => {
      if (isFoldedWorkEntryChunk(chunk)) return chunk;
      return {
        ...chunk,
        entries: chunk.entries.filter(
          (entry) => !shouldCapEntry(entry) || visibleEntrySet.has(entry),
        ),
      };
    }),
    hasOverflow,
    hiddenEntryCount,
  };
}

// The newest work group in the transcript — the one still allowed to render its
// rows inline while the turn is live. Everything older collapses to a summary.
export function findLastLiveWorkGroupId(rows: ReadonlyArray<MessagesTimelineRow>): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "work") {
      return row.id;
    }
    if (row.kind === "message") {
      const groupId = row.inlineWorkGroupId ?? row.leadingWorkGroupId;
      if (groupId) {
        return groupId;
      }
      // A user message closes the previous turn: nothing before it is live.
      if (row.message.role === "user") {
        return null;
      }
    }
  }
  return null;
}

/** The model a turn ran on, as the provider reported it. */
export interface TurnModel {
  readonly provider: ProviderKind;
  readonly model: string;
}

/** Provider-reported lifecycle of one turn, used for its settled header. */
export interface TurnTiming {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** The turn ended interrupted; the source may be unknown. */
  readonly interrupted: boolean;
  /** A Stop request for this turn preceded its interrupted outcome. */
  readonly stoppedByUser?: boolean;
  /** The provider ended the turn early (error, usage limit, crash). */
  readonly failed?: boolean;
  /** Short reason for a provider-side interruption, when known. */
  readonly failureReason?: string | null;
  readonly model?: TurnModel | null;
}

function activityPayloadRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  const payload = activity.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const MAX_TURN_FAILURE_REASON_CHARS = 80;

// A short, human reason for a provider-side interruption: well-known causes get
// a fixed phrase, anything else its first line, clipped to sit in a header.
export function summarizeTurnFailureReason(input: {
  errorCode?: string | null;
  message?: string | null;
}): string | null {
  const message = input.message?.trim() ?? "";
  if (input.errorCode === "server_overloaded" || /at capacity|overloaded/i.test(message)) {
    return "model at capacity";
  }
  if (/usage limit|rate limit|quota|out of credits/i.test(message)) {
    return "usage limit reached";
  }
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return null;
  }
  return firstLine.length > MAX_TURN_FAILURE_REASON_CHARS
    ? `${firstLine.slice(0, MAX_TURN_FAILURE_REASON_CHARS - 1).trimEnd()}…`
    : firstLine;
}

// The model a `turn.started` activity names; Claude's context-window reports
// stand in for turns recorded before turns carried their model.
function activityTurnModel(activity: OrchestrationThreadActivity): {
  model: TurnModel;
  authoritative: boolean;
} | null {
  const payload = activityPayloadRecord(activity);
  if (activity.kind === "turn.started") {
    const model = nonEmptyString(payload?.model);
    const provider = nonEmptyString(payload?.provider);
    return model && provider && isProviderKind(provider)
      ? { model: { provider, model }, authoritative: true }
      : null;
  }
  if (activity.kind === "context-window.updated") {
    const claudeCache = payload?.claudeCache;
    const model =
      typeof claudeCache === "object" && claudeCache !== null
        ? nonEmptyString((claudeCache as Record<string, unknown>).model)
        : null;
    return model ? { model: { provider: "claudeAgent", model }, authoritative: false } : null;
  }
  return null;
}

// Collects what the thread knows about each turn's real start, end and outcome.
// Checkpoints carry earlier turns, the latest turn carries the live one, and the
// turn lifecycle activities say which turns were stopped or failed and which
// model ran them.
export function deriveTurnTimingByTurnId(input: {
  turnDiffSummaries: ReadonlyArray<Pick<TurnDiffSummary, "turnId" | "startedAt" | "completedAt">>;
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "startedAt" | "completedAt"
  > | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyMap<TurnId, TurnTiming> {
  const timings = new Map<TurnId, TurnTiming>();
  const update = (turnId: TurnId, patch: Partial<TurnTiming>) => {
    const timing = timings.get(turnId);
    timings.set(turnId, {
      startedAt: timing?.startedAt ?? null,
      completedAt: timing?.completedAt ?? null,
      interrupted: timing?.interrupted ?? false,
      ...(timing?.failed ? { failed: true, failureReason: timing.failureReason ?? null } : {}),
      ...(timing?.model ? { model: timing.model } : {}),
      ...patch,
    });
  };
  for (const summary of input.turnDiffSummaries) {
    timings.set(summary.turnId, {
      startedAt: summary.startedAt ?? null,
      completedAt: summary.completedAt,
      interrupted: false,
    });
  }
  const settledStateByTurnId = new Map<TurnId, unknown>();
  const authoritativeModelTurnIds = new Set<TurnId>();
  const stopRequestedAtByTurnId = new Map<TurnId, string>();
  for (const activity of input.activities) {
    if (activity.turnId === null) continue;
    const payload = activityPayloadRecord(activity);
    if (activity.kind === "turn.stop-requested" && payload?.requestedBy === "user") {
      if (!stopRequestedAtByTurnId.has(activity.turnId))
        stopRequestedAtByTurnId.set(activity.turnId, activity.createdAt);
      continue;
    }
    if (activity.kind === "turn.started") {
      update(activity.turnId, {
        startedAt: timings.get(activity.turnId)?.startedAt ?? activity.createdAt,
      });
    }
    if (activity.kind === "turn.completed") {
      update(activity.turnId, {
        completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt,
      });
    }
    const turnModel = activityTurnModel(activity);
    if (turnModel && !authoritativeModelTurnIds.has(activity.turnId)) {
      if (turnModel.authoritative) authoritativeModelTurnIds.add(activity.turnId);
      update(activity.turnId, { model: turnModel.model });
      continue;
    }
    if (activity.kind === "turn.completed" || activity.kind === "turn.aborted") {
      settledStateByTurnId.set(
        activity.turnId,
        activity.kind === "turn.aborted" ? "interrupted" : payload?.state,
      );
    }
    const stopped =
      activity.kind === "turn.aborted" ||
      (activity.kind === "turn.completed" &&
        (payload?.state === "interrupted" || payload?.state === "cancelled"));
    if (stopped) {
      update(activity.turnId, {
        completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt,
        interrupted: true,
      });
      continue;
    }
    const failed =
      (activity.kind === "turn.completed" &&
        (payload?.state === "failed" || activity.tone === "error")) ||
      activity.kind === "runtime.error";
    if (failed) {
      const previousReason = timings.get(activity.turnId)?.failureReason ?? null;
      update(activity.turnId, {
        failed: true,
        failureReason:
          summarizeTurnFailureReason({
            errorCode: nonEmptyString(payload?.errorCode),
            message: nonEmptyString(payload?.errorMessage) ?? nonEmptyString(payload?.message),
          }) ?? previousReason,
        ...(activity.kind === "turn.completed"
          ? { completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt }
          : {}),
      });
    }
  }
  // A runtime error the turn recovered from is not how it ended.
  for (const [turnId, state] of settledStateByTurnId) {
    const timing = timings.get(turnId);
    if (timing?.failed && state === "completed") {
      const { failed: _failed, failureReason: _failureReason, ...rest } = timing;
      timings.set(turnId, rest);
    }
  }
  const latestTurn = input.latestTurn;
  if (latestTurn) {
    const timing = timings.get(latestTurn.turnId);
    update(latestTurn.turnId, {
      startedAt: latestTurn.startedAt ?? timing?.startedAt ?? null,
      completedAt: latestTurn.completedAt ?? timing?.completedAt ?? null,
      interrupted: latestTurn.state === "interrupted" || (timing?.interrupted ?? false),
      ...(latestTurn.state === "error" && !timing?.failed
        ? { failed: true, failureReason: null }
        : {}),
    });
  }
  for (const [turnId, timing] of timings) {
    const requestedAt = stopRequestedAtByTurnId.get(turnId);
    if (
      timing.interrupted &&
      !timing.failed &&
      requestedAt &&
      timing.completedAt &&
      Date.parse(requestedAt) <= Date.parse(timing.completedAt)
    ) {
      timings.set(turnId, { ...timing, stoppedByUser: true });
    }
  }
  return timings;
}

// "“Run delayed echo” finished", or a count when several tasks woke the turn.
export function formatTurnResumedBy(resumedBy: ReadonlyArray<TurnResumedBy>): string {
  if (resumedBy.length === 1) {
    const [only] = resumedBy;
    return `“${only!.description ?? "Background task"}” ${only!.outcome}`;
  }
  const outcomes = new Set(resumedBy.map((item) => item.outcome));
  return outcomes.size === 1
    ? `${resumedBy.length} background tasks ${resumedBy[0]!.outcome}`
    : `${resumedBy.length} background tasks ended`;
}

// The text of a settled turn header, without the clock time, model or icon:
// "Worked 20s", "Stopped by you after 16s", "Interrupted after 16s · usage
// limit reached", "Resumed: “Run delayed echo” finished · 3s".
export function formatTurnHeaderLabel(
  header: Pick<TurnHeader, "elapsed" | "outcome" | "reason" | "resumedBy">,
): string {
  switch (header.outcome) {
    case "stopped":
      return header.elapsed ? `Stopped by you after ${header.elapsed}` : "Stopped by you";
    case "interrupted": {
      const base = header.elapsed ? `Interrupted after ${header.elapsed}` : "Interrupted";
      return header.reason ? `${base} · ${header.reason}` : base;
    }
    case "completed":
      if (header.resumedBy && header.resumedBy.length > 0) {
        const resumed = `Resumed: ${formatTurnResumedBy(header.resumedBy)}`;
        return header.elapsed ? `${resumed} · ${header.elapsed}` : resumed;
      }
      return header.elapsed ? `Worked ${header.elapsed}` : "Worked";
  }
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  turnId?: string | null;
  completedAt?: string | undefined;
}

interface TimelineDiffMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  turnId: TurnId | null;
}

/** A background task whose completion woke the agent into a new turn. */
export interface TurnResumedBy {
  readonly description: string | null;
  readonly outcome: "finished" | "failed" | "stopped";
}

/**
 * The line that opens every settled turn: "Worked 20s · 22:33 ✓", with the
 * final state, the model only when it changed since the previous turn, and
 * the background task that woke the turn when one did.
 */
export interface TurnHeader {
  readonly elapsed: string | null;
  /** When the turn ended, for the clock time. */
  readonly endedAt: string | null;
  readonly outcome: "completed" | "stopped" | "interrupted";
  /** Why the provider interrupted the turn, when known. */
  readonly reason: string | null;
  readonly modelChange: TurnModel | null;
  readonly resumedBy: ReadonlyArray<TurnResumedBy> | null;
}

export interface TurnEndMarker {
  readonly elapsed: string | null;
  readonly outcome: "stopped" | "interrupted";
  readonly reason: string | null;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      // Set on the last row of a stopped turn that has no settled header.
      turnEndMarker?: TurnEndMarker;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      leadingWorkEntries?: WorkLogEntry[];
      leadingWorkGroupId?: string;
      inlineWorkEntries?: WorkLogEntry[];
      inlineWorkGroupId?: string;
      collapsedTurnItems?: CollapsedTurnItem[];
      // Set on the terminal assistant, or the request if an interrupted turn
      // produced no assistant/work rows.
      turnHeader?: TurnHeader;
      // Set on the last row of a stopped turn that has no settled header.
      turnEndMarker?: TurnEndMarker;
      durationStart: string;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      // True while this row's turn is still running. The end-of-turn changes
      // card (Undo / Review) is held back until the turn settles so it cannot
      // pre-empt the composer's live changes strip mid-turn.
      assistantTurnInProgress?: boolean | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      // One slice of a completed assistant message whose streamed text was
      // interleaved with tool rows; rendered compactly at its own start time.
      kind: "message-segment";
      id: string;
      createdAt: string;
      message: ChatMessage;
      segmentIndex: number;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      // An answered agent question shown as a question/answer exchange. Like
      // the plan card it stays visible when the turn folds into the turn header.
      kind: "user-input";
      id: string;
      createdAt: string;
      entry: WorkLogEntry & { userInputExchange: ReadonlyArray<WorkLogUserInputExchangeItem> };
    }
  | { kind: "working"; id: string; createdAt: string | null }
  | {
      // Live-turn header that mirrors the settled turn header ("Working 12s"
      // + hairline), but is non-collapsible and counts up while the turn is
      // still running. Sits at the top of the active turn.
      kind: "working-header";
      id: string;
      createdAt: string;
      modelChange?: TurnModel | null;
      resumedBy?: ReadonlyArray<TurnResumedBy> | null;
    }
  | {
      // Transient "Preparing worktree..." step card shown during the New
      // worktree first-send setup. `open` drives the shared disclosure close
      // animation while the presentation hook keeps the row mounted.
      kind: "worktree-setup";
      id: string;
      steps: ReadonlyArray<WorktreeSetupStep>;
      open: boolean;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export interface ThreadFindJumpTarget {
  rowIndex: number;
  visibleMessageId: MessageId;
  expandCollapsedWorkMessageId?: MessageId;
  collapsedNarrationMessageId?: MessageId;
}

/**
 * Map a find match onto the row that currently owns it. Settled turns splice
 * earlier assistant messages out of the live list and fold them into the
 * terminal row's collapsed narration, so jumping by message id alone misses.
 */
export function resolveThreadFindJumpTarget(
  rows: readonly MessagesTimelineRow[],
  match: { messageId: MessageId; segmentIndex?: number },
): ThreadFindJumpTarget | null {
  const { messageId, segmentIndex } = match;
  if (segmentIndex !== undefined) {
    const segmentRowIndex = rows.findIndex(
      (row) =>
        row.kind === "message-segment" &&
        row.message.id === messageId &&
        row.segmentIndex === segmentIndex,
    );
    if (segmentRowIndex >= 0) {
      return { rowIndex: segmentRowIndex, visibleMessageId: messageId };
    }
  }

  const messageRowIndex = rows.findIndex(
    (row) => row.kind === "message" && row.message.id === messageId,
  );
  if (messageRowIndex >= 0) {
    return { rowIndex: messageRowIndex, visibleMessageId: messageId };
  }

  const anySegmentRowIndex = rows.findIndex(
    (row) => row.kind === "message-segment" && row.message.id === messageId,
  );
  if (anySegmentRowIndex >= 0) {
    return { rowIndex: anySegmentRowIndex, visibleMessageId: messageId };
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    if (row.kind !== "message" || row.message.role !== "assistant") {
      continue;
    }
    const hasNarration = (row.collapsedTurnItems ?? []).some(
      (item) => item.kind === "narration" && item.message.id === messageId,
    );
    if (!hasNarration) {
      continue;
    }
    return {
      rowIndex,
      visibleMessageId: row.message.id,
      expandCollapsedWorkMessageId: row.message.id,
      collapsedNarrationMessageId: messageId,
    };
  }

  return null;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return normalizeCompactToolLabelValue(value);
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const normalizedText = text?.trim() ? text : null;
  return {
    text: normalizedText,
    visible: showCopyButton && normalizedText !== null && !streaming,
  };
}

type AssistantMessageDisplayInput = {
  readonly message: Pick<ChatMessage, "text" | "streaming">;
  readonly leadingWorkEntries?: ReadonlyArray<WorkLogEntry>;
  readonly inlineWorkEntries?: ReadonlyArray<WorkLogEntry>;
  readonly collapsedTurnItems?: ReadonlyArray<CollapsedTurnItem>;
};

function isVisibleGeneratedImageEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "image_generation" &&
    entry.activityKind === "tool.completed" &&
    entry.tone !== "error"
  );
}

/**
 * Resolves the markdown body for an assistant row. A completed image-generation
 * work item is already visible non-text output, so an adjacent empty provider
 * message must not add the misleading "(empty response)" placeholder. Truly
 * empty settled turns retain the placeholder, and live empty text stays blank.
 */
export function resolveAssistantMessageDisplayText(
  input: AssistantMessageDisplayInput,
): string | null {
  if (input.message.text) {
    return input.message.text;
  }
  if (input.message.streaming) {
    return "";
  }

  const hasVisibleGeneratedImage = [
    ...(input.leadingWorkEntries ?? []),
    ...(input.inlineWorkEntries ?? []),
    ...(input.collapsedTurnItems ?? []).flatMap((item) =>
      item.kind === "work" ? [item.entry] : [],
    ),
  ].some(isVisibleGeneratedImageEntry);

  return hasVisibleGeneratedImage ? null : "(empty response)";
}

// Builds the "Files changed" lookup keyed by the last assistant row in the
// user-visible response segment. Provider mini-turns can emit diffs before the
// final answer, so the card follows the segment tail instead of the raw turn.
export function buildTurnDiffSummaryByAssistantMessageId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  messages: ReadonlyArray<TimelineDiffMessage>;
}): Map<MessageId, TurnDiffSummary> {
  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  if (input.turnDiffSummaries.length === 0) return byMessageId;

  const summaryByTurnId = new Map<string, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    summaryByTurnId.set(summary.turnId, summary);
  }

  const messageIndexByTurnId = new Map<string, number>();
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    if (message.role !== "assistant" || !message.turnId) continue;
    messageIndexByTurnId.set(message.turnId, index);
  }

  for (const [turnId, summary] of summaryByTurnId) {
    const anchorIndex = messageIndexByTurnId.get(turnId);
    if (anchorIndex === undefined) continue;
    let terminalAssistantMessageId: MessageId | null = null;
    for (let index = anchorIndex; index < input.messages.length; index += 1) {
      const message = input.messages[index]!;
      if (index > anchorIndex && message.role === "user") break;
      if (message.role === "assistant") {
        terminalAssistantMessageId = message.id;
      }
    }
    if (!terminalAssistantMessageId) continue;

    byMessageId.set(
      terminalAssistantMessageId,
      mergeTurnDiffSummaries(byMessageId.get(terminalAssistantMessageId), summary),
    );
  }
  return byMessageId;
}

// Keeps multi-turn provider responses from losing earlier "Files changed" rows
// when several turn-diff summaries anchor to the same final assistant message.
function mergeTurnDiffSummaries(
  existing: TurnDiffSummary | undefined,
  next: TurnDiffSummary,
): TurnDiffSummary {
  const checkpointTurnCountsFor = (summary: TurnDiffSummary): number[] => {
    if (
      summary.files.length === 0 ||
      summary.status === "missing" ||
      summary.status === "error" ||
      summary.checkpointRef === undefined ||
      summary.checkpointRef.startsWith("provider-diff:")
    ) {
      return [];
    }
    return (
      summary.checkpointTurnCounts ??
      (summary.checkpointTurnCount === undefined ? [] : [summary.checkpointTurnCount])
    );
  };
  if (!existing) {
    const checkpointTurnCounts = checkpointTurnCountsFor(next);
    return { ...next, checkpointTurnCounts };
  }

  const filesByPath = new Map(existing.files.map((file) => [file.path, file]));
  for (const file of next.files) {
    filesByPath.set(file.path, file);
  }
  const checkpointTurnCounts = new Set([
    ...checkpointTurnCountsFor(existing),
    ...checkpointTurnCountsFor(next),
  ]);
  const undoMetadata =
    checkpointTurnCountsFor(next).length > 0
      ? next
      : checkpointTurnCountsFor(existing).length > 0
        ? existing
        : next;
  const allDisplayedFilesUndoable = [existing, next].every(
    (summary) => summary.files.length === 0 || checkpointTurnCountsFor(summary).length > 0,
  );

  return {
    ...next,
    files: [...filesByPath.values()],
    checkpointRef: undoMetadata.checkpointRef,
    status: undoMetadata.status,
    checkpointTurnCount: undoMetadata.checkpointTurnCount,
    checkpointTurnCounts: allDisplayedFilesUndoable
      ? [...checkpointTurnCounts].toSorted((left, right) => left - right)
      : [],
  };
}

export function deriveTerminalAssistantMessageIds(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Set<string> {
  const terminalAssistantMessageIds = new Set<string>();
  let latestAssistantMessageId: string | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") {
      if (latestAssistantMessageId) {
        terminalAssistantMessageIds.add(latestAssistantMessageId);
        latestAssistantMessageId = null;
      }
      continue;
    }
    latestAssistantMessageId = message.id;
  }

  if (latestAssistantMessageId) {
    terminalAssistantMessageIds.add(latestAssistantMessageId);
  }

  return terminalAssistantMessageIds;
}

// Server-posted coordinator notices and provider handoff boundaries keep their own
// row: they are not turn work, so they never merge into or fold with a turn.
export function isStandaloneWorkEntry(
  entry: Pick<WorkLogEntry, "synaraWorkerNotice" | "providerHandoff" | "turnFailure">,
): boolean {
  return Boolean(entry.synaraWorkerNotice || entry.providerHandoff || entry.turnFailure);
}

// Derives transcript rows from timeline entries while keeping live narration and
// tool rows in visual chronology. Work already waiting when assistant text
// arrives renders above that text; trailing work renders below it.
export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
  worktreeSetup: WorktreeSetupSnapshot | null;
  worktreeSetupOpen: boolean;
  activeTurnInProgress?: boolean;
  // Background subagents still running after the parent turn ended: the parent
  // turn is idle but its work is not done, so it must not fold yet.
  subagentsRunning?: boolean;
  // User setting: false keeps every finished turn expanded.
  collapseFinishedTurns?: boolean;
  activeTurnId?: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  // Real per-turn start/end/outcome; settled headers fall back to message
  // timestamps for turns missing here.
  turnTimingByTurnId?: ReadonlyMap<TurnId, TurnTiming>;
  conversationOnly?: boolean;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  // A finished background task wakes the agent into a new response, so it ends
  // the previous response and starts the next one's clock like a user message.
  const responseMessages = input.timelineEntries.flatMap((entry): TimelineDurationMessage[] =>
    entry.kind === "message"
      ? [entry.message]
      : entry.kind === "work" &&
          (entry.entry.backgroundTaskCompletion || entry.entry.monitorNotification)
        ? [{ id: entry.id, role: "user", createdAt: entry.createdAt }]
        : [],
  );
  const durationStartByMessageId = computeMessageDurationStart(responseMessages);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(responseMessages);
  let pendingWorkGroup: Extract<MessagesTimelineRow, { kind: "work" }> | null = null;

  const groupedEntriesEqual = (
    left: ReadonlyArray<WorkLogEntry>,
    right: ReadonlyArray<WorkLogEntry>,
  ) => left.length === right.length && left.every((entry, index) => entry === right[index]);

  const appendWorkEntriesToPreviousAssistant = (
    groupedEntries: WorkLogEntry[],
    groupId: string,
  ): boolean => {
    const previousRow = nextRows.at(-1);
    if (
      !previousRow ||
      previousRow.kind !== "message" ||
      previousRow.message.role !== "assistant"
    ) {
      return false;
    }

    const nextInlineWorkEntries = previousRow.inlineWorkEntries
      ? [...previousRow.inlineWorkEntries, ...groupedEntries]
      : groupedEntries;

    if (groupedEntriesEqual(previousRow.inlineWorkEntries ?? [], nextInlineWorkEntries)) {
      return true;
    }

    previousRow.inlineWorkEntries = nextInlineWorkEntries;
    previousRow.inlineWorkGroupId ??= groupId;
    return true;
  };

  const flushPendingWorkGroup = (options?: { attachToPreviousAssistant?: boolean }) => {
    if (!pendingWorkGroup) return;
    const shouldAttachToPreviousAssistant = options?.attachToPreviousAssistant ?? true;
    if (
      !shouldAttachToPreviousAssistant ||
      !appendWorkEntriesToPreviousAssistant(pendingWorkGroup.groupedEntries, pendingWorkGroup.id)
    ) {
      nextRows.push(pendingWorkGroup);
    }
    pendingWorkGroup = null;
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const run = [
        { entry: timelineEntry.entry, id: timelineEntry.id, createdAt: timelineEntry.createdAt },
      ];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        run.push({ entry: nextEntry.entry, id: nextEntry.id, createdAt: nextEntry.createdAt });
        cursor += 1;
      }
      // Server-posted coordinator monitor rows keep their own work row: the
      // leading/inline merges into an assistant message hide them on
      // conversation-only surfaces, so they must never join a mergeable group.
      // Background task completions do too: they separate two responses.
      for (const runEntry of run) {
        const userInputExchange = runEntry.entry.userInputExchange;
        if (userInputExchange) {
          flushPendingWorkGroup({ attachToPreviousAssistant: false });
          nextRows.push({
            kind: "user-input",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            entry: { ...runEntry.entry, userInputExchange },
          });
        } else if (
          isStandaloneWorkEntry(runEntry.entry) ||
          runEntry.entry.backgroundTaskCompletion ||
          runEntry.entry.monitorNotification
        ) {
          flushPendingWorkGroup();
          nextRows.push({
            kind: "work",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            groupedEntries: [runEntry.entry],
          });
        } else if (pendingWorkGroup) {
          pendingWorkGroup.groupedEntries.push(runEntry.entry);
        } else {
          pendingWorkGroup = {
            kind: "work",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            groupedEntries: [runEntry.entry],
          };
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      // A plan card is a visible mid-turn artifact. Keep adjacent work as its
      // own row so final turn collapse can preserve the true chronology.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "message-segment") {
      // Interleaved slice of assistant text, already alternating with the tool
      // rows in timeline order. Do not merge pending work into it: segment
      // boundaries ARE tool interventions, so each segment stands alone.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "message-segment",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        segmentIndex: timelineEntry.segmentIndex,
      });
      continue;
    }

    const message = timelineEntry.message;
    const leadingWorkEntries =
      message.role === "assistant" ? pendingWorkGroup?.groupedEntries : undefined;
    const leadingWorkGroupId = message.role === "assistant" ? pendingWorkGroup?.id : undefined;
    if (message.role === "assistant") {
      pendingWorkGroup = null;
    } else {
      flushPendingWorkGroup();
    }

    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      message.turnId === input.activeTurnId;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      ...(leadingWorkEntries ? { leadingWorkEntries } : {}),
      ...(leadingWorkGroupId ? { leadingWorkGroupId } : {}),
      durationStart: durationStartByMessageId.get(message.id) ?? message.createdAt,
      showAssistantCopyButton:
        message.role === "assistant" && terminalAssistantMessageIds.has(message.id),
      assistantCopyStreaming: message.streaming || assistantTurnStillInProgress,
      assistantTurnInProgress: assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(message.id)
          : undefined,
      revertTurnCount:
        message.role === "user" ? input.revertTurnCountByUserMessageId.get(message.id) : undefined,
    });
  }

  // Keep any trailing work summary visually attached to the last answer so a
  // completed chat does not end with a detached tool-log footer.
  flushPendingWorkGroup();

  const liveBoundary = findLiveTurnHeaderInsertion(nextRows, input.activeTurnId ?? null);
  if (liveBoundary.resumedStartedAt) {
    for (const row of nextRows) {
      if (
        row.kind === "message" &&
        row.message.role === "assistant" &&
        row.assistantTurnInProgress &&
        Date.parse(row.createdAt) < Date.parse(liveBoundary.resumedStartedAt)
      ) {
        row.assistantTurnInProgress = false;
        row.assistantCopyStreaming = row.message.streaming;
      }
    }
  }

  if (input.worktreeSetup) {
    nextRows.push({
      kind: "worktree-setup",
      id: "worktree-setup-row",
      steps: input.worktreeSetup.steps,
      open: input.worktreeSetupOpen,
    });
  }

  // The generic Thinking shimmer remains the single live status. Provider work
  // rows are transcript history and must never replace it.
  if (input.isWorking && !(input.worktreeSetup && input.worktreeSetupOpen)) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  if (input.conversationOnly !== true) {
    collapseSettledTurns(nextRows, {
      terminalAssistantMessageIds,
      collapseWork: input.collapseFinishedTurns !== false,
      activeTurnInProgress:
        (input.activeTurnInProgress ?? false) || (input.subagentsRunning ?? false),
      activeTurnId: input.activeTurnId ?? null,
      activeResponseStartedAt: liveBoundary.resumedStartedAt,
      turnTimingByTurnId: input.turnTimingByTurnId,
    });
  }

  if (input.conversationOnly !== true && input.turnTimingByTurnId) {
    markInterruptedTurnsWithoutHeader(nextRows, input.turnTimingByTurnId);
  }

  // The live turn wears a "Working 12s" header + hairline — the counting-up
  // twin of a settled turn's header. It anchors to the top of the active turn
  // (right after the user message that opened it, or the background task
  // completion that woke it) and needs a real start time to count from; the
  // trailing "Thinking" shimmer covers the gap before one exists. Inserted
  // after collapse so folding is untouched.
  if (
    input.conversationOnly !== true &&
    input.isWorking &&
    input.activeTurnStartedAt &&
    !(input.worktreeSetup && input.worktreeSetupOpen)
  ) {
    const { index, resumedBy, resumedStartedAt } = findLiveTurnHeaderInsertion(
      nextRows,
      input.activeTurnId ?? null,
    );
    nextRows.splice(index, 0, {
      kind: "working-header",
      id: "working-header-row",
      createdAt: resumedStartedAt ?? input.activeTurnStartedAt,
      ...(resumedBy ? { resumedBy } : {}),
    });
  }

  if (input.conversationOnly !== true && input.turnTimingByTurnId) {
    assignTurnHeaderModelChanges(nextRows, input.turnTimingByTurnId, input.activeTurnId ?? null);
  }

  // A finished background task already shows on its own row and in the header
  // of the turn it woke ("Resumed: … finished"), so its completion line goes.
  return input.conversationOnly === true
    ? nextRows
    : nextRows.filter((row) => !isBackgroundTaskCompletionRow(row));
}

// A stopped turn opens with a "Stopped by you after Xs" header when it has a
// final assistant message. One that was stopped before writing anything (or
// with folding turned off) ends on its own rows, so its last row carries the
// turn-end marker.
function markInterruptedTurnsWithoutHeader(
  rows: MessagesTimelineRow[],
  turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming>,
): void {
  const headedTurnIds = new Set<TurnId>();
  const lastRowIndexByTurnId = new Map<TurnId, number>();
  const requestRowIndexByTurnId = new Map<TurnId, number>();
  rows.forEach((row, index) => {
    if (row.kind === "message" && row.message.role === "assistant" && row.message.turnId) {
      if (row.turnHeader) headedTurnIds.add(row.message.turnId);
      lastRowIndexByTurnId.set(row.message.turnId, index);
    } else if (row.kind === "work") {
      for (const entry of row.groupedEntries) {
        if (entry.turnId) lastRowIndexByTurnId.set(entry.turnId, index);
      }
    } else if (
      row.kind === "message" &&
      row.message.role === "user" &&
      row.message.turnId &&
      row.message.startsNewTurn !== false &&
      !requestRowIndexByTurnId.has(row.message.turnId)
    ) {
      requestRowIndexByTurnId.set(row.message.turnId, index);
    }
  });
  for (const [turnId, index] of lastRowIndexByTurnId) {
    const timing = turnTimingByTurnId.get(turnId);
    if (!timing || (!timing.interrupted && !timing.failed) || headedTurnIds.has(turnId)) continue;
    const row = rows[index]!;
    if (row.kind !== "work" && row.kind !== "message") continue;
    row.turnEndMarker = {
      elapsed:
        timing.startedAt && timing.completedAt
          ? (formatElapsed(timing.startedAt, timing.completedAt) ?? null)
          : null,
      outcome: timing.stoppedByUser && !timing.failed ? "stopped" : "interrupted",
      reason: timing.failureReason ?? null,
    };
  }
  // A request bound to a terminal turn is durable ownership evidence. A
  // queued, unbound request or Stop intent alone must never acquire a header.
  for (const [turnId, index] of requestRowIndexByTurnId) {
    if (lastRowIndexByTurnId.has(turnId) || headedTurnIds.has(turnId)) continue;
    const timing = turnTimingByTurnId.get(turnId);
    if (!timing?.completedAt || (!timing.interrupted && !timing.failed)) continue;
    const row = rows[index]!;
    if (row.kind !== "message") continue;
    row.turnHeader = {
      elapsed: timing.startedAt
        ? (formatElapsed(timing.startedAt, timing.completedAt) ?? null)
        : null,
      endedAt: timing.completedAt,
      outcome: timing.stoppedByUser && !timing.failed ? "stopped" : "interrupted",
      reason: timing.failureReason ?? null,
      modelChange: null,
      resumedBy: null,
    };
  }
}

// The live turn starts at the request that opened it, so its header slots in
// right after it: requests queued behind the live turn stay below its work. A
// turn with no request of its own that a background task woke starts at that
// task's completion. A request not yet bound to its turn falls back to the
// most recent user message. Absent any user message (degenerate transcripts)
// the header leads the transcript so the "Working" copy is never lost.
function findLiveTurnHeaderInsertion(
  rows: ReadonlyArray<MessagesTimelineRow>,
  activeTurnId: TurnId | null,
): { index: number; resumedBy: TurnResumedBy[] | null; resumedStartedAt: string | null } {
  const lastCompletionIndex = rows.findLastIndex(isBackgroundTaskCompletionRow);
  const completionRow = rows[lastCompletionIndex];
  const completionBoundary = () => ({
    index: lastCompletionIndex + 1,
    resumedBy: collectResumedBy(rows, lastCompletionIndex),
    resumedStartedAt: completionRow?.kind === "work" ? completionRow.createdAt : null,
  });
  if (activeTurnId !== null) {
    const requestIndex = rows.findLastIndex(
      (row) =>
        row.kind === "message" &&
        row.message.role === "user" &&
        row.message.turnId === activeTurnId,
    );
    if (requestIndex >= 0) {
      // A completed answer before a newer notification proves a response
      // boundary even when the provider reuses the original request's id.
      const precedingAssistant = rows
        .slice(requestIndex + 1, lastCompletionIndex)
        .findLast(
          (row) =>
            row.kind === "message" &&
            row.message.role === "assistant" &&
            row.message.turnId === activeTurnId,
        );
      if (
        lastCompletionIndex > requestIndex &&
        precedingAssistant?.kind === "message" &&
        !precedingAssistant.message.streaming &&
        precedingAssistant.message.completedAt
      ) {
        return completionBoundary();
      }
      return { index: requestIndex + 1, resumedBy: null, resumedStartedAt: null };
    }
  }
  const lastRequestIndex = rows.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );
  if (lastCompletionIndex > lastRequestIndex) {
    return completionBoundary();
  }
  return { index: lastRequestIndex + 1, resumedBy: null, resumedStartedAt: null };
}

// Returns the terminal assistant only when it is still the transcript tail.
// A newer user message means the next turn has begun but has not produced text yet.
function isBackgroundTaskCompletionRow(row: MessagesTimelineRow): boolean {
  return (
    row.kind === "work" &&
    row.groupedEntries.some((entry) => entry.backgroundTaskCompletion || entry.monitorNotification)
  );
}

function findTailTerminalAssistantMessageId(
  rows: ReadonlyArray<MessagesTimelineRow>,
  terminalAssistantMessageIds: ReadonlySet<string>,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    // A response woken by a background task has not produced its own terminal
    // message yet; the previous response stays settled.
    if (isBackgroundTaskCompletionRow(row)) return null;
    if (row.kind !== "message") {
      continue;
    }
    return row.message.role === "assistant" && terminalAssistantMessageIds.has(row.message.id)
      ? row.message.id
      : null;
  }
  return null;
}

// Post-pass: collapse each *settled* turn into a single turn header
// disclosure on the turn's terminal assistant message. Unlike a per-message
// collapse, this folds every non-terminal assistant narration (preambles) AND
// the turn's tool work into one ordered group, so the transcript shows a single
// toggle + the final answer per turn (Remodex-style). The live turn stays
// expanded/inline so streaming output is never hidden behind a toggle.
function collapseSettledTurns(
  rows: MessagesTimelineRow[],
  options: {
    terminalAssistantMessageIds: ReadonlySet<string>;
    collapseWork: boolean;
    activeTurnInProgress: boolean;
    activeTurnId: TurnId | null;
    activeResponseStartedAt: string | null;
    turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming> | undefined;
  },
): void {
  const { terminalAssistantMessageIds, activeTurnInProgress, activeTurnId, turnTimingByTurnId } =
    options;
  const lastTerminalAssistantMessageId = activeTurnInProgress
    ? findTailTerminalAssistantMessageId(rows, terminalAssistantMessageIds)
    : null;

  const collectWorkItems = (entries: ReadonlyArray<WorkLogEntry>, into: CollapsedTurnItem[]) => {
    for (const entry of entries) {
      into.push({ kind: "work", id: entry.id, entry });
    }
  };

  const earliestTimestamp = (a: string, b: string): string => {
    const aMs = Date.parse(a);
    const bMs = Date.parse(b);
    if (Number.isNaN(aMs)) return b;
    if (Number.isNaN(bMs)) return a;
    return bMs < aMs ? b : a;
  };

  for (let pass = rows.length - 1; pass >= 0; pass -= 1) {
    const row = rows[pass]!;
    if (row.kind !== "message" || row.message.role !== "assistant") continue;
    const message = row.message;
    if (message.asyncUserInput) continue;
    // Only the terminal message of a turn owns the collapsed group.
    if (!terminalAssistantMessageIds.has(message.id)) continue;
    // Never collapse the live turn: streaming text or the in-progress turn stays
    // inline so the user sees output as it arrives.
    if (message.streaming) continue;
    const turnId = message.turnId ?? null;
    const turnIsActive =
      activeTurnInProgress &&
      (!options.activeResponseStartedAt ||
        Date.parse(message.createdAt) >= Date.parse(options.activeResponseStartedAt)) &&
      (activeTurnId != null
        ? (turnId != null && turnId === activeTurnId) ||
          message.id === lastTerminalAssistantMessageId
        : message.id === lastTerminalAssistantMessageId);
    if (turnIsActive) continue;

    // Scan back to the response boundary collecting rows to fold. Provider
    // mini-turns can have distinct turnIds inside one assistant answer, so the
    // user message boundary is the stable UI grouping point.
    const foldIndices: number[] = [];
    let wokenAt: string | null = null;
    let resumedBy: TurnResumedBy[] | null = null;
    for (let scan = pass - 1; scan >= 0; scan -= 1) {
      const prev = rows[scan]!;
      // The response started where a background task woke the agent; every
      // completion that arrived together woke it.
      if (isBackgroundTaskCompletionRow(prev)) {
        wokenAt = prev.kind === "work" ? prev.createdAt : null;
        resumedBy = collectResumedBy(rows, scan);
        break;
      }
      if (prev.kind === "work") {
        // Coordinator monitor rows are server-posted system pills, not turn
        // work — folding them into a collapsed turn would hide them on
        // conversation-only surfaces.
        if (prev.groupedEntries.some(isStandaloneWorkEntry)) continue;
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "message" && prev.message.role === "assistant") {
        if (prev.message.asyncUserInput) break;
        foldIndices.push(scan);
        continue;
      }
      // A settled assistant message whose streamed text interleaved with tool
      // rows renders as message-segment slices. They are still this turn's
      // narration, so they fold too instead of stranding everything earlier
      // outside the disclosure.
      if (prev.kind === "message-segment" && !prev.message.streaming) {
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "proposed-plan" || prev.kind === "user-input") {
        // The plan card and answered questions stay visible, but they should not strand earlier
        // narration/work outside the final turn header disclosure.
        continue;
      }
      break;
    }
    foldIndices.reverse();

    const collapsedItems: CollapsedTurnItem[] = [];
    // The disclosure folds everything back to the user boundary, so "Worked
    // for" must start where the folded segment starts. The terminal row's own
    // durationStart advances past intermediate *completed* assistant messages
    // (e.g. a failed attempt before a retry), which would report only the tail
    // of the turn instead of the full run.
    let collapsedStart = row.durationStart;
    // Provider mini-turns can split one answer across turn ids; the group runs
    // from the earliest of their starts.
    const foldedTurnIds = new Set<TurnId>(turnId ? [turnId] : []);
    // All slices of one segmented message share the same ChatMessage, so the
    // message folds once (at its first slice) to keep narration identity stable.
    const foldedSegmentMessageIds = new Set<string>();
    for (const index of foldIndices) {
      const folded = rows[index]!;
      if (
        (folded.kind === "message" || folded.kind === "message-segment") &&
        folded.message.turnId
      ) {
        foldedTurnIds.add(folded.message.turnId);
      }
      if (folded.kind === "work") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collectWorkItems(folded.groupedEntries, collapsedItems);
      } else if (folded.kind === "message-segment") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        if (!foldedSegmentMessageIds.has(folded.message.id)) {
          foldedSegmentMessageIds.add(folded.message.id);
          collapsedItems.push({
            kind: "narration",
            id: folded.message.id,
            message: folded.message,
          });
        }
      } else if (folded.kind === "message" && folded.message.role === "assistant") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.durationStart);
        if (folded.assistantTurnDiffSummary) {
          row.assistantTurnDiffSummary = mergeTurnDiffSummaries(
            folded.assistantTurnDiffSummary,
            row.assistantTurnDiffSummary ?? folded.assistantTurnDiffSummary,
          );
        }
        if (folded.leadingWorkEntries) collectWorkItems(folded.leadingWorkEntries, collapsedItems);
        if (folded.collapsedTurnItems) collapsedItems.push(...folded.collapsedTurnItems);
        collapsedItems.push({ kind: "narration", id: folded.message.id, message: folded.message });
        if (folded.inlineWorkEntries) collectWorkItems(folded.inlineWorkEntries, collapsedItems);
      }
    }
    // The terminal's own work rows are details around the final answer; fold
    // them into the disclosure so completed chats do not end with tool-log rows.
    if (row.leadingWorkEntries) collectWorkItems(row.leadingWorkEntries, collapsedItems);
    if (row.inlineWorkEntries) collectWorkItems(row.inlineWorkEntries, collapsedItems);

    // Message timestamps only bound the visible output: a turn without a
    // request (subagent child), a stopped turn, or a turn woken by a
    // background task would report the wrong span. Prefer the turn's own.
    const nextResponseBoundary = rows
      .slice(pass + 1)
      .find(
        (candidate) =>
          isBackgroundTaskCompletionRow(candidate) ||
          (candidate.kind === "message" && candidate.message.role === "user"),
      );
    const nextResponseBoundaryAt =
      nextResponseBoundary?.kind === "work" || nextResponseBoundary?.kind === "message"
        ? nextResponseBoundary.createdAt
        : null;
    const timingForThisResponse = (id: TurnId) => {
      const timing = turnTimingByTurnId?.get(id);
      if (
        nextResponseBoundaryAt &&
        ((timing?.startedAt &&
          Date.parse(timing.startedAt) >= Date.parse(nextResponseBoundaryAt)) ||
          (timing?.completedAt &&
            Date.parse(timing.completedAt) >= Date.parse(nextResponseBoundaryAt)))
      )
        return undefined;
      return timing;
    };
    const turnTiming = turnId ? timingForThisResponse(turnId) : undefined;
    let turnStart: string | null = null;
    for (const foldedTurnId of foldedTurnIds) {
      const startedAt = timingForThisResponse(foldedTurnId)?.startedAt ?? null;
      if (startedAt !== null) {
        turnStart = turnStart === null ? startedAt : earliestTimestamp(turnStart, startedAt);
      }
    }
    // A provider can open the turn a woken response belongs to only when it
    // replies; that response started when the background task finished.
    if (wokenAt !== null) turnStart = wokenAt;
    // A provider can reuse the launching turn id for a notification response.
    // An earlier terminal record belongs to the launch, not the resumed work.
    const responseTiming =
      wokenAt !== null &&
      (!turnTiming?.completedAt || Date.parse(turnTiming.completedAt) < Date.parse(wokenAt))
        ? undefined
        : turnTiming;
    const responseEnd = responseTiming?.completedAt ?? message.completedAt;
    const elapsed = formatElapsed(turnStart ?? collapsedStart, responseEnd);
    // Every settled turn opens with its header, with or without work to fold.
    const header: TurnHeader = {
      elapsed: elapsed ?? null,
      endedAt: responseEnd ?? message.createdAt,
      outcome: responseTiming?.failed
        ? "interrupted"
        : responseTiming?.stoppedByUser
          ? "stopped"
          : responseTiming?.interrupted
            ? "interrupted"
            : "completed",
      reason: responseTiming?.failureReason ?? null,
      modelChange: null,
      resumedBy,
    };

    if (!options.collapseWork) {
      const firstAssistant = foldIndices
        .map((index) => rows[index]!)
        .find(
          (candidate) => candidate.kind === "message" && candidate.message.role === "assistant",
        );
      if (firstAssistant?.kind === "message") firstAssistant.turnHeader = header;
      else row.turnHeader = header;
      continue;
    }
    row.turnHeader = header;
    if (collapsedItems.length > 0) {
      row.collapsedTurnItems = collapsedItems;
      delete row.leadingWorkEntries;
      delete row.leadingWorkGroupId;
      delete row.inlineWorkEntries;
      delete row.inlineWorkGroupId;

      for (const index of foldIndices.toSorted((a, b) => b - a)) {
        rows.splice(index, 1);
      }
      pass -= foldIndices.length;
    }
  }
}

// The background tasks whose completion rows end at `index`, oldest first.
function collectResumedBy(
  rows: ReadonlyArray<MessagesTimelineRow>,
  index: number,
): TurnResumedBy[] | null {
  const resumedBy: TurnResumedBy[] = [];
  for (let scan = index; scan >= 0; scan -= 1) {
    const row = rows[scan]!;
    if (!isBackgroundTaskCompletionRow(row) || row.kind !== "work") break;
    for (const entry of row.groupedEntries.toReversed()) {
      const completion = entry.backgroundTaskCompletion;
      if (!completion) continue;
      resumedBy.unshift({
        description: completion.description,
        outcome: completion.outcome ?? "finished",
      });
    }
  }
  return resumedBy.length > 0 ? resumedBy : null;
}

function turnModelsEqual(left: TurnModel, right: TurnModel): boolean {
  return left.provider === right.provider && left.model === right.model;
}

// Headers name the model only where it changed: each turn compares against
// the previous turn that reported one. The live header compares against the
// last settled one.
function assignTurnHeaderModelChanges(
  rows: MessagesTimelineRow[],
  turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming>,
  activeTurnId: TurnId | null,
): void {
  let previousModel: TurnModel | null = null;
  for (const row of rows) {
    const turnId =
      row.kind === "message" && row.turnHeader
        ? (row.message.turnId ?? null)
        : row.kind === "working-header"
          ? activeTurnId
          : null;
    if (turnId === null) continue;
    const model = turnTimingByTurnId.get(turnId)?.model ?? null;
    if (!model) continue;
    const modelChange =
      previousModel !== null && !turnModelsEqual(previousModel, model) ? model : null;
    if (row.kind === "message" && row.turnHeader) {
      row.turnHeader = { ...row.turnHeader, modelChange };
    } else if (row.kind === "working-header") {
      row.modelChange = modelChange;
    }
    previousModel = model;
  }
}

// Reuses stable row references so streaming updates only invalidate rows whose
// visible content actually changed.
export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function stringArraysEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function workLogSubagentActionsEqual(
  a: WorkLogEntry["subagentAction"],
  b: WorkLogEntry["subagentAction"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tool === b.tool &&
    a.status === b.status &&
    a.summaryText === b.summaryText &&
    a.model === b.model &&
    a.prompt === b.prompt
  );
}

function workLogSubagentsEqual(
  left: WorkLogEntry["subagents"],
  right: WorkLogEntry["subagents"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((a, index) => {
    const b = right[index];
    return (
      b !== undefined &&
      a.threadId === b.threadId &&
      a.providerThreadId === b.providerThreadId &&
      a.resolvedThreadId === b.resolvedThreadId &&
      a.agentId === b.agentId &&
      a.nickname === b.nickname &&
      a.role === b.role &&
      a.model === b.model &&
      a.prompt === b.prompt &&
      a.rawStatus === b.rawStatus &&
      a.latestUpdate === b.latestUpdate &&
      a.title === b.title &&
      a.statusLabel === b.statusLabel &&
      a.isActive === b.isActive
    );
  });
}

// Automation card fields are visible row content, so stale equality would freeze the transcript UI.
function workLogAutomationsEqual(a: WorkLogEntry["automation"], b: WorkLogEntry["automation"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.cadenceLabel === b.cadenceLabel &&
    a.proposalState === b.proposalState
  );
}

function workLogSynaraThreadCreationsEqual(
  a: WorkLogEntry["synaraThreadCreation"],
  b: WorkLogEntry["synaraThreadCreation"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.operationId !== b.operationId ||
    a.requestedCount !== b.requestedCount ||
    a.createdCount !== b.createdCount ||
    a.threads.length !== b.threads.length
  ) {
    return false;
  }
  return a.threads.every((thread, index) => {
    const other = b.threads[index];
    return (
      other !== undefined &&
      thread.threadId === other.threadId &&
      thread.title === other.title &&
      thread.provider === other.provider &&
      thread.model === other.model &&
      thread.environment === other.environment &&
      thread.status === other.status
    );
  });
}

function workLogToolOutputsEqual(
  a: NonNullable<WorkLogEntry["toolDetails"]>["output"],
  b: NonNullable<WorkLogEntry["toolDetails"]>["output"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.output === b.output &&
    a.stdout === b.stdout &&
    a.stderr === b.stderr &&
    a.exitCode === b.exitCode &&
    a.truncated === b.truncated
  );
}

function workLogToolEditsEqual(
  left: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
  right: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((edit, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      edit.path === other.path &&
      edit.oldText === other.oldText &&
      edit.newText === other.newText
    );
  });
}

function workLogToolDetailsEqual(a: WorkLogEntry["toolDetails"], b: WorkLogEntry["toolDetails"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.command === b.command &&
    a.diff === b.diff &&
    a.content === b.content &&
    stringArraysEqual(a.files, b.files) &&
    workLogToolOutputsEqual(a.output, b.output) &&
    workLogToolEditsEqual(a.edits, b.edits)
  );
}

function workLogLiveActivitiesEqual(
  a: WorkLogEntry["liveActivity"],
  b: WorkLogEntry["liveActivity"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.label === b.label &&
    a.startedAt === b.startedAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.detail === b.detail &&
    a.progress === b.progress &&
    a.elapsedSeconds === b.elapsedSeconds
  );
}

function workLogEntryContentEqual(a: WorkLogEntry, b: WorkLogEntry): boolean {
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.turnId === b.turnId &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.toolTitle === b.toolTitle &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.preview === b.preview &&
    a.tone === b.tone &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.activityKind === b.activityKind &&
    a.toolName === b.toolName &&
    a.toolCallId === b.toolCallId &&
    a.toolStatus === b.toolStatus &&
    stringArraysEqual(a.changedFiles, b.changedFiles) &&
    workLogSubagentActionsEqual(a.subagentAction, b.subagentAction) &&
    workLogSubagentsEqual(a.subagents, b.subagents) &&
    workLogAutomationsEqual(a.automation, b.automation) &&
    workLogSynaraThreadCreationsEqual(a.synaraThreadCreation, b.synaraThreadCreation) &&
    workLogLiveActivitiesEqual(a.liveActivity, b.liveActivity) &&
    workLogToolDetailsEqual(a.toolDetails, b.toolDetails) &&
    workLogBackgroundTasksEqual(a.backgroundTask, b.backgroundTask) &&
    a.userInputExchange === b.userInputExchange
  );
}

function workLogEntryArraysEqual(
  left: ReadonlyArray<WorkLogEntry> | undefined,
  right: ReadonlyArray<WorkLogEntry> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => workLogEntryContentEqual(entry, right[index]!));
}

function collapsedTurnItemsEqual(
  left: ReadonlyArray<CollapsedTurnItem> | undefined,
  right: ReadonlyArray<CollapsedTurnItem> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index]!;
    if (item.kind !== other.kind || item.id !== other.id) return false;
    if (item.kind === "work" && other.kind === "work") {
      return workLogEntryContentEqual(item.entry, other.entry);
    }
    if (item.kind === "narration" && other.kind === "narration") {
      return item.message === other.message;
    }
    return false;
  });
}

function turnModelsMatch(left: TurnModel | null, right: TurnModel | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return turnModelsEqual(left, right);
}

function resumedByEqual(
  left: ReadonlyArray<TurnResumedBy> | null,
  right: ReadonlyArray<TurnResumedBy> | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.description === right[index]!.description && item.outcome === right[index]!.outcome,
  );
}

function turnHeadersEqual(left: TurnHeader | undefined, right: TurnHeader | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.elapsed === right.elapsed &&
    left.endedAt === right.endedAt &&
    left.outcome === right.outcome &&
    left.reason === right.reason &&
    turnModelsMatch(left.modelChange, right.modelChange) &&
    resumedByEqual(left.resumedBy, right.resumedBy)
  );
}

function turnEndMarkersEqual(
  left: TurnEndMarker | undefined,
  right: TurnEndMarker | undefined,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.elapsed === right.elapsed &&
      left.outcome === right.outcome &&
      left.reason === right.reason,
    )
  );
}

function workLogBackgroundTasksEqual(
  a: WorkLogEntry["backgroundTask"],
  b: WorkLogEntry["backgroundTask"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.taskId === b.taskId &&
    a.status === b.status &&
    a.command === b.command &&
    a.description === b.description &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.exitCode === b.exitCode
  );
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "working-header": {
      const bh = b as typeof a;
      return (
        a.createdAt === bh.createdAt &&
        turnModelsMatch(a.modelChange ?? null, bh.modelChange ?? null) &&
        resumedByEqual(a.resumedBy ?? null, bh.resumedBy ?? null)
      );
    }

    case "worktree-setup": {
      const bw = b as typeof a;
      return (
        a.open === bw.open &&
        a.steps.length === bw.steps.length &&
        a.steps.every((step, index) => {
          const other = bw.steps[index]!;
          return step.id === other.id && step.status === other.status && step.label === other.label;
        })
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "user-input":
      return a.entry.userInputExchange === (b as typeof a).entry.userInputExchange;

    case "work":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        turnEndMarkersEqual(a.turnEndMarker, (b as typeof a).turnEndMarker) &&
        workLogEntryArraysEqual(a.groupedEntries, (b as typeof a).groupedEntries)
      );

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        workLogEntryArraysEqual(a.leadingWorkEntries, bm.leadingWorkEntries) &&
        a.leadingWorkGroupId === bm.leadingWorkGroupId &&
        workLogEntryArraysEqual(a.inlineWorkEntries, bm.inlineWorkEntries) &&
        a.inlineWorkGroupId === bm.inlineWorkGroupId &&
        collapsedTurnItemsEqual(a.collapsedTurnItems, bm.collapsedTurnItems) &&
        turnHeadersEqual(a.turnHeader, bm.turnHeader) &&
        turnEndMarkersEqual(a.turnEndMarker, bm.turnEndMarker) &&
        a.durationStart === bm.durationStart &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnInProgress === bm.assistantTurnInProgress &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }

    case "message-segment": {
      const bm = b as typeof a;
      return a.message === bm.message && a.segmentIndex === bm.segmentIndex;
    }
  }
}
