// FILE: MessagesTimeline.logic.ts
// Purpose: Owns the pure row-derivation helpers used by the transcript hot path.
// Layer: Web chat presentation helpers
// Exports: row derivation, structural sharing, copy/timer helpers

import { type MessageId, type TurnId } from "@t3tools/contracts";
import { type TimelineEntry, type WorkLogEntry, formatElapsed } from "../../session-logic";
import { normalizeCompactToolLabel as normalizeCompactToolLabelValue } from "../../lib/toolCallLabel";
import {
  type ChatMessage,
  type ProposedPlan,
  type TurnDiffSummary,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStep,
} from "../../types";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

// Ordered item folded into a settled turn's single "Worked for Xs" disclosure.
// A turn can interleave tool work and intermediate assistant narration
// (preambles), so the collapsed panel keeps both in chronological order.
export type CollapsedTurnItem =
  | { kind: "work"; id: string; entry: WorkLogEntry }
  | { kind: "narration"; id: string; message: ChatMessage };

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

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
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
      collapsedWorkElapsed?: string | null;
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
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null }
  | {
      // Live-turn header that mirrors the settled "Worked for Xs" disclosure
      // (label + full-width divider), but is non-collapsible and counts up while
      // the turn is still running. Sits at the top of the active turn.
      kind: "working-header";
      id: string;
      createdAt: string;
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
  if (!existing) return next;

  const filesByPath = new Map(existing.files.map((file) => [file.path, file]));
  for (const file of next.files) {
    filesByPath.set(file.path, file);
  }

  return {
    ...next,
    files: [...filesByPath.values()],
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

// Derives transcript rows from timeline entries while keeping live narration and
// tool rows in visual chronology. Work already waiting when assistant text
// arrives renders above that text; trailing work renders below it.
export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
  worktreeSetup: WorktreeSetupSnapshot | null;
  worktreeSetupOpen: boolean;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const timelineMessages = input.timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const durationStartByMessageId = computeMessageDurationStart(timelineMessages);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineMessages);
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
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      flushPendingWorkGroup();
      pendingWorkGroup = {
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      };
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

    const leadingWorkEntries =
      timelineEntry.message.role === "assistant" ? pendingWorkGroup?.groupedEntries : undefined;
    const leadingWorkGroupId =
      timelineEntry.message.role === "assistant" ? pendingWorkGroup?.id : undefined;
    if (timelineEntry.message.role === "assistant") {
      pendingWorkGroup = null;
    } else {
      flushPendingWorkGroup();
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      timelineEntry.message.turnId === input.activeTurnId;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(leadingWorkEntries ? { leadingWorkEntries } : {}),
      ...(leadingWorkGroupId ? { leadingWorkGroupId } : {}),
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnInProgress: assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  // Keep any trailing work summary visually attached to the last answer so a
  // completed chat does not end with a detached tool-log footer.
  flushPendingWorkGroup();

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

  collapseSettledTurns(nextRows, {
    terminalAssistantMessageIds,
    activeTurnInProgress: input.activeTurnInProgress ?? false,
    activeTurnId: input.activeTurnId ?? null,
  });

  // The live turn wears a "Working for Xs" header + divider — the counting-up
  // twin of a settled turn's "Worked for Xs" disclosure. It anchors to the top
  // of the active turn (right after the user message that opened it) and needs a
  // real start time to count from; the trailing "Thinking" shimmer covers the
  // gap before one exists. Inserted after collapse so folding is untouched.
  if (
    input.isWorking &&
    input.activeTurnStartedAt &&
    !(input.worktreeSetup && input.worktreeSetupOpen)
  ) {
    nextRows.splice(findLiveTurnHeaderInsertIndex(nextRows), 0, {
      kind: "working-header",
      id: "working-header-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

// The live turn starts at the most recent user message, so its header slots in
// right after it. Absent any user message (degenerate transcripts) the header
// leads the transcript so the "Working for" copy is never lost.
function findLiveTurnHeaderInsertIndex(rows: ReadonlyArray<MessagesTimelineRow>): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "message" && row.message.role === "user") {
      return index + 1;
    }
  }
  return 0;
}

// Returns the terminal assistant only when it is still the transcript tail.
// A newer user message means the next turn has begun but has not produced text yet.
function findTailTerminalAssistantMessageId(
  rows: ReadonlyArray<MessagesTimelineRow>,
  terminalAssistantMessageIds: ReadonlySet<string>,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "message") {
      continue;
    }
    return row.message.role === "assistant" && terminalAssistantMessageIds.has(row.message.id)
      ? row.message.id
      : null;
  }
  return null;
}

// Post-pass: collapse each *settled* turn into a single "Worked for Xs"
// disclosure on the turn's terminal assistant message. Unlike a per-message
// collapse, this folds every non-terminal assistant narration (preambles) AND
// the turn's tool work into one ordered group, so the transcript shows a single
// toggle + the final answer per turn (Remodex-style). The live turn stays
// expanded/inline so streaming output is never hidden behind a toggle.
function collapseSettledTurns(
  rows: MessagesTimelineRow[],
  options: {
    terminalAssistantMessageIds: ReadonlySet<string>;
    activeTurnInProgress: boolean;
    activeTurnId: TurnId | null;
  },
): void {
  const { terminalAssistantMessageIds, activeTurnInProgress, activeTurnId } = options;
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
    // Only the terminal message of a turn owns the collapsed group.
    if (!terminalAssistantMessageIds.has(row.message.id)) continue;
    // Never collapse the live turn: streaming text or the in-progress turn stays
    // inline so the user sees output as it arrives.
    if (row.message.streaming) continue;
    const turnId = row.message.turnId ?? null;
    const turnIsActive =
      activeTurnInProgress &&
      (activeTurnId != null
        ? (turnId != null && turnId === activeTurnId) ||
          row.message.id === lastTerminalAssistantMessageId
        : row.message.id === lastTerminalAssistantMessageId);
    if (turnIsActive) continue;

    // Scan back to the response boundary collecting rows to fold. Provider
    // mini-turns can have distinct turnIds inside one assistant answer, so the
    // user message boundary is the stable UI grouping point.
    const foldIndices: number[] = [];
    for (let scan = pass - 1; scan >= 0; scan -= 1) {
      const prev = rows[scan]!;
      if (prev.kind === "work") {
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "message" && prev.message.role === "assistant") {
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "proposed-plan") {
        // The plan card stays visible, but it should not strand earlier
        // narration/work outside the final "Worked for..." disclosure.
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
    for (const index of foldIndices) {
      const folded = rows[index]!;
      if (folded.kind === "work") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collectWorkItems(folded.groupedEntries, collapsedItems);
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

    if (collapsedItems.length > 0) {
      const elapsed = formatElapsed(collapsedStart, row.message.completedAt);
      row.collapsedTurnItems = collapsedItems;
      row.collapsedWorkElapsed = elapsed ?? null;
      delete row.leadingWorkEntries;
      delete row.leadingWorkGroupId;
      delete row.inlineWorkEntries;
      delete row.inlineWorkGroupId;

      for (const index of [...foldIndices].sort((a, b) => b - a)) {
        rows.splice(index, 1);
      }
      pass -= foldIndices.length;
    }
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
  return a.id === b.id && a.name === b.name && a.cadenceLabel === b.cadenceLabel;
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
    stringArraysEqual(a.changedFiles, b.changedFiles) &&
    workLogSubagentActionsEqual(a.subagentAction, b.subagentAction) &&
    workLogSubagentsEqual(a.subagents, b.subagents) &&
    workLogAutomationsEqual(a.automation, b.automation) &&
    workLogToolDetailsEqual(a.toolDetails, b.toolDetails)
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

function shallowEqualEntryArray<T>(
  left: ReadonlyArray<T> | undefined,
  right: ReadonlyArray<T> | undefined,
) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "working-header":
      return a.createdAt === (b as typeof a).createdAt;

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

    case "work":
      return (
        a.createdAt === (b as typeof a).createdAt &&
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
        a.collapsedWorkElapsed === bm.collapsedWorkElapsed &&
        a.durationStart === bm.durationStart &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnInProgress === bm.assistantTurnInProgress &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
