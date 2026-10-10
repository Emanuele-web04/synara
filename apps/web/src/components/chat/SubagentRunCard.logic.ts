// FILE: SubagentRunCard.logic.ts
// Purpose: Folds routed subagent work into entries for its invocations, and
// derives each transcript card's rows (identity, live state, current action,
// durations, result preview, nested subagents) and its
// header counts.
// Layer: Chat transcript logic
// Exports: foldSubagentRunWorkEntries, deriveSubagentRunCard,
// findLatestRunningSubagentRun, and the card model types

import { ThreadId, type TurnId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";

import {
  deriveWorkLogEntries,
  formatClockDuration,
  isRoutedSubagentWorkEntry,
  isSubagentStateOnlyWorkEntry,
  type WorkLogEntry,
  type WorkLogSubagent,
  type WorkLogSubagentRun,
  type WorkLogSubagentRunMember,
  type SubagentTaskEnd,
} from "../../session-logic";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentationForThread,
  resolveSubagentThreadStatusKind,
  type SubagentStatusKind,
} from "../../lib/subagentPresentation";
import type { Thread } from "../../types";
import {
  mergeSubagentSnapshots,
  toSubagentStripItem,
  type ComposerSubagentStripItem,
} from "./ComposerSubagentStrip.logic";

const SUBAGENT_RUN_ENTRY_ID_PREFIX = "subagent-run:";
const OUTCOME_PREVIEW_MAX_LENGTH = 160;

type MutableRunMember = {
  -readonly [Key in keyof WorkLogSubagentRunMember]: WorkLogSubagentRunMember[Key];
};

interface RunDraft {
  anchorIndex: number;
  anchor: WorkLogEntry;
  subagentByKey: Map<string, WorkLogSubagent>;
  memberByKey: Map<string, MutableRunMember>;
}

function runKeyForEntry(entry: WorkLogEntry): string {
  return entry.turnId ? `turn:${entry.turnId}` : `entry:${entry.id}`;
}

function isTerminalStatus(status: string | null | undefined): boolean {
  const kind = normalizeSubagentStatusKind(status ?? null);
  return kind === "completed" || kind === "failed" || kind === "stopped";
}

// A launching call that itself failed carries the reason in its output.
function launchFailure(entry: WorkLogEntry): string | null {
  if (normalizeSubagentStatusKind(entry.subagentAction?.status ?? null) !== "failed") {
    return null;
  }
  const text = (entry.detail ?? "").trim();
  return text.length > 0 ? text : null;
}

function progressStep(entry: WorkLogEntry): string | null {
  const text = (entry.detail ?? entry.preview ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Distinct children launched in a turn share a card at the first launch. A
 * repeat launch/resume of a child opens another invocation, even in that turn.
 * Later state-only calls (wait, close, settled) update its latest invocation,
 * and progress reports feed the matching invocation's current step. State-only
 * calls about unknown subagents are dropped, as before.
 */
export function foldSubagentRunWorkEntries(
  entries: ReadonlyArray<WorkLogEntry>,
): ReadonlyArray<WorkLogEntry> {
  const runs = new Map<string, RunDraft>();
  const runKeyBySubagentKey = new Map<string, string>();
  const droppedIndexes = new Set<number>();

  entries.forEach((entry, index) => {
    if (!isRoutedSubagentWorkEntry(entry)) {
      return;
    }
    droppedIndexes.add(index);
    const stateOnly = isSubagentStateOnlyWorkEntry(entry);
    for (const subagent of entry.subagents ?? []) {
      const key = subagent.threadId;
      // A resume starts another invocation in its launching turn. State-only
      // reports may arrive in later parent turns and still settle the last run.
      let runKey = runKeyForEntry(entry);
      const previousRun = runs.get(runKeyBySubagentKey.get(key) ?? "");
      let knownRun =
        stateOnly || previousRun?.anchor.turnId === entry.turnId ? previousRun : runs.get(runKey);
      if (
        !stateOnly &&
        knownRun?.subagentByKey.has(key) &&
        knownRun.anchor.id !== entry.id &&
        (/^(?:spawn|resume)[_-]?agent$/i.test(entry.subagentAction?.tool ?? "") ||
          isTerminalStatus(knownRun.subagentByKey.get(key)?.rawStatus))
      ) {
        // A parent may finish and resume the same child more than once in a
        // single turn. Keep each invocation's outcome and clock; an input to
        // an already running child remains an update to its current run.
        runKey = `entry:${entry.id}`;
        knownRun = runs.get(runKey);
      }
      if (knownRun?.subagentByKey.has(key)) {
        const previous = knownRun.subagentByKey.get(key);
        knownRun.subagentByKey.set(
          key,
          previous ? mergeSubagentSnapshots(previous, subagent) : subagent,
        );
        const member = knownRun.memberByKey.get(key);
        if (member && member.settledAt === null && isTerminalStatus(subagent.rawStatus)) {
          member.settledAt = entry.createdAt;
        }
        continue;
      }
      if (stateOnly) {
        continue;
      }
      const previousMember = previousRun?.memberByKey.get(key);
      if (previousMember && previousRun !== knownRun) {
        previousMember.nextLaunchedAt = entry.createdAt;
      }
      let run = runs.get(runKey);
      if (!run) {
        run = {
          anchorIndex: index,
          anchor: entry,
          subagentByKey: new Map(),
          memberByKey: new Map(),
        };
        runs.set(runKey, run);
      }
      run.subagentByKey.set(key, subagent);
      run.memberByKey.set(key, {
        key,
        launchedAt: entry.createdAt,
        latestStep: null,
        outcome: null,
        failure: launchFailure(entry),
        settledAt: null,
      });
      runKeyBySubagentKey.set(key, runKey);
      if (subagent.providerThreadId) {
        runKeyBySubagentKey.set(subagent.providerThreadId, runKey);
      }
    }
  });

  if (droppedIndexes.size === 0) {
    return entries;
  }

  const invocationsBySubagentKey = new Map<
    string,
    Array<{ run: RunDraft; member: MutableRunMember }>
  >();
  for (const run of runs.values()) {
    for (const member of run.memberByKey.values()) {
      const providerThreadId = run.subagentByKey.get(member.key)?.providerThreadId;
      for (const alias of new Set([member.key, providerThreadId ?? member.key])) {
        const invocations = invocationsBySubagentKey.get(alias) ?? [];
        invocations.push({ run, member });
        invocationsBySubagentKey.set(alias, invocations);
      }
    }
  }

  // A subagent's progress reports become its row's current step.
  entries.forEach((entry, index) => {
    const progress = entry.subagentProgress;
    if (!progress) {
      return;
    }
    const invocations = (invocationsBySubagentKey.get(progress.toolUseId) ?? []).filter(
      ({ run }) => !entry.turnId || run.anchor.turnId === entry.turnId,
    );
    // Late reports retain their original invocation even when the parent
    // turn is reused. A lone launch retains the existing timestamp fallback.
    const member = (
      invocations.findLast(
        ({ member }) => Date.parse(entry.createdAt) >= Date.parse(member.launchedAt),
      ) ?? invocations[0]
    )?.member;
    if (!member) {
      return;
    }
    member.latestStep = progressStep(entry) ?? member.latestStep;
    member.outcome = progress.outcome ?? member.outcome;
    droppedIndexes.add(index);
  });

  const runByAnchorIndex = new Map([...runs.values()].map((run) => [run.anchorIndex, run]));
  const folded: WorkLogEntry[] = [];
  entries.forEach((entry, index) => {
    const run = runByAnchorIndex.get(index);
    if (run) {
      folded.push(toSubagentRunEntry(run));
      return;
    }
    if (!droppedIndexes.has(index)) {
      folded.push(entry);
    }
  });
  return folded;
}

function toSubagentRunEntry(run: RunDraft): WorkLogEntry {
  const { anchor } = run;
  return {
    id: `${SUBAGENT_RUN_ENTRY_ID_PREFIX}${anchor.id}`,
    createdAt: anchor.createdAt,
    ...(anchor.sequence !== undefined ? { sequence: anchor.sequence } : {}),
    ...(anchor.turnId !== undefined ? { turnId: anchor.turnId } : {}),
    label: "Subagents",
    // Not a tool call: it never folds into "Ran N tool calls" or the inline
    // tool cap, and renders in the status block of its message.
    tone: "info",
    itemType: "collab_agent_tool_call",
    subagents: [...run.subagentByKey.values()],
    subagentRun: { members: [...run.memberByKey.values()] },
  };
}

export function isSubagentRunWorkEntry(
  entry: Pick<WorkLogEntry, "subagentRun">,
): entry is WorkLogEntry & { subagentRun: WorkLogSubagentRun } {
  return entry.subagentRun !== undefined;
}

// ── Card model ────────────────────────────────────────────────────────────────

export type SubagentRunPhase =
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted";

export interface SubagentRunAction {
  /** The shell command the subagent is (or was last) running. */
  command: string | null;
  /** A plain description when the step is not a shell command. */
  label: string | null;
}

export interface SubagentRunRow {
  key: string;
  /** Identity, status, and the task-control handle Stop/background use. */
  item: ComposerSubagentStripItem;
  /** The child thread, once it is known. */
  threadId: ThreadId | null;
  phase: SubagentRunPhase;
  startedAtMs: number | null;
  endedAtMs: number | null;
  action: SubagentRunAction | null;
  /** One-line result preview (done) or cause (failed). */
  outcomeText: string | null;
  nested: SubagentRunRow[];
}

export interface SubagentRunCounts {
  running: number;
  done: number;
  failed: number;
  stopped: number;
  interrupted: number;
}

export interface SubagentRunCardModel {
  rows: SubagentRunRow[];
  /** Subagents launched by the card's subagents, at any depth. */
  nestedCount: number;
  /** Over every row, nested ones included. */
  counts: SubagentRunCounts;
  isLive: boolean;
  /** Every subagent ended because it was stopped. */
  allStopped: boolean;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

export type SubagentRunThread = Pick<
  Thread,
  | "id"
  | "title"
  | "createdAt"
  | "error"
  | "session"
  | "latestTurn"
  | "messages"
  | "activities"
  | "modelSelection"
  | "parentThreadId"
  | "sourceThreadId"
  | "subagentAgentId"
  | "subagentNickname"
  | "subagentRole"
>;

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

interface InvocationWindow {
  startedAtMs: number | null;
  endedAtMs: number | null;
  beforeMs: number | null;
}

function withinInvocation(value: string | null | undefined, window: InvocationWindow): boolean {
  const time = parseTimeMs(value);
  return (
    time !== null &&
    (window.startedAtMs === null || time >= window.startedAtMs) &&
    (window.endedAtMs === null || time <= window.endedAtMs) &&
    (window.beforeMs === null || time < window.beforeMs)
  );
}

const invocationThreads = new WeakMap<SubagentRunThread, Map<string, SubagentRunThread>>();

// Child threads are reusable; their current session/error/latest turn must not
// overwrite an older invocation. Cache the bounded view as live clocks tick.
function threadForInvocation(
  thread: SubagentRunThread,
  window: InvocationWindow,
): SubagentRunThread {
  const key = `${window.startedAtMs}:${window.endedAtMs}:${window.beforeMs}`;
  let views = invocationThreads.get(thread);
  const cached = views?.get(key);
  if (cached) return cached;
  const latestTurnMatches = thread.latestTurn
    ? withinInvocation(thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt, window)
    : window.beforeMs === null;
  const view: SubagentRunThread = {
    ...thread,
    messages: thread.messages.filter((message) => withinInvocation(message.createdAt, window)),
    activities: thread.activities.filter((activity) =>
      withinInvocation(activity.createdAt, window),
    ),
    latestTurn: latestTurnMatches ? thread.latestTurn : null,
    session: latestTurnMatches ? thread.session : null,
    error: latestTurnMatches ? thread.error : null,
  };
  if (!views) {
    views = new Map();
    invocationThreads.set(thread, views);
  }
  views.set(key, view);
  return view;
}

const childActionByActivities = new WeakMap<
  SubagentRunThread["activities"],
  SubagentRunAction | null
>();

// The child's latest tool step, cached per activity array: rows re-derive every
// second while a subagent runs, but the step only changes with new activity.
function latestChildAction(thread: SubagentRunThread): SubagentRunAction | null {
  const cached = childActionByActivities.get(thread.activities);
  if (cached !== undefined) {
    return cached;
  }
  let action: SubagentRunAction | null = null;
  if (thread.activities.length > 0) {
    // The activity array already belongs to this invocation, including tools
    // without a provider turn ID and earlier child turns within the same run.
    const entries = deriveWorkLogEntries(thread.activities, undefined);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.tone !== "tool" || entry.subagentRun || (entry.subagents?.length ?? 0) > 0) {
        continue;
      }
      const command = entry.command?.trim() || null;
      const label = (entry.toolTitle ?? entry.label).trim() || null;
      action = command ? { command, label: null } : label ? { command: null, label } : null;
      if (action) {
        break;
      }
    }
  }
  childActionByActivities.set(thread.activities, action);
  return action;
}

// Progress steps read "Running <what>"; the row already says the verb.
function actionFromStep(step: string | null): SubagentRunAction | null {
  const label = step?.replace(/^running\s+/i, "").trim();
  return label ? { command: null, label } : null;
}

export function firstLinePreview(text: string | null | undefined): string | null {
  const line = text
    ?.split(/\r?\n/)
    .map((candidate) =>
      candidate
        .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+)/, "")
        .replace(/\*\*|__/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((candidate) => candidate.length > 0 && !/^```/.test(candidate));
  if (!line) {
    return null;
  }
  return line.length > OUTCOME_PREVIEW_MAX_LENGTH
    ? `${line.slice(0, OUTCOME_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}

function latestAssistantText(thread: SubagentRunThread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.role === "assistant" && !message.streaming && message.text.trim().length > 0) {
      return message.text;
    }
  }
  return null;
}

function phaseFromStatusKind(
  statusKind: SubagentStatusKind | null,
  outcome: WorkLogSubagentRunMember["outcome"],
): SubagentRunPhase | null {
  // A task completion that says stopped/failed is more specific than a
  // generic "finished" from the child's session.
  if (outcome === "stopped" && statusKind !== "running") return "stopped";
  if (outcome === "failed" && statusKind !== "running") return "failed";
  switch (statusKind) {
    case "running":
      return "running";
    case "queued":
      return "starting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return outcome === "completed" ? "done" : null;
  }
}

function isTerminalPhase(phase: SubagentRunPhase): boolean {
  return phase === "done" || phase === "failed" || phase === "stopped" || phase === "interrupted";
}

// A direct subagent's state. The launching call's own "completed" is not used:
// Codex spawn calls (and Claude background launches) complete as soon as the
// subagent starts. What counts, in order: the subagent's own reported state,
// its task completion, live work on its thread, a failed launch, its thread's
// latest turn, and, while the launching turn runs, its thread existing.
function directRowPhase(input: {
  subagent: WorkLogSubagent;
  member: WorkLogSubagentRunMember | undefined;
  thread: SubagentRunThread | undefined;
  launchTurnLive: boolean;
  taskEnd: SubagentTaskEnd | undefined;
  background: boolean;
}): SubagentRunPhase | null {
  const { subagent, member, thread, launchTurnLive, taskEnd, background } = input;
  if (/^(interrupted|aborted)$/i.test(subagent.rawStatus?.trim() ?? "")) {
    return "interrupted";
  }
  const rawKind = normalizeSubagentStatusKind(subagent.rawStatus ?? null);
  if (rawKind === "completed" || rawKind === "failed" || rawKind === "stopped") {
    return phaseFromStatusKind(rawKind, null);
  }
  const outcome = taskEnd?.outcome ?? member?.outcome;
  if (outcome) {
    return phaseFromStatusKind(null, outcome);
  }
  if (subagent.isActive) {
    return "running";
  }
  if (member?.failure) {
    return "failed";
  }
  // A background launch ends the child's first turn at once; until its task
  // completes, it is still at work.
  if (background) {
    return "running";
  }
  const threadPhase = thread
    ? phaseFromStatusKind(resolveSubagentThreadStatusKind(thread), null)
    : null;
  if (threadPhase) {
    return threadPhase;
  }
  // Its thread exists, so it started; Codex children have no session or
  // closing turn to say more while the launching turn runs.
  if (rawKind === "running" || (launchTurnLive && thread !== undefined)) {
    return "running";
  }
  if (rawKind === "queued") {
    return "starting";
  }
  // Codex children report no end of their own: once the launching turn is
  // over with nothing else known, the launch call having completed is all
  // there is to go on.
  return launchTurnLive ? null : "done";
}

function outcomeTextFor(
  phase: SubagentRunPhase,
  thread: SubagentRunThread | undefined,
  launchFailureText: string | null = null,
) {
  if (phase === "done") return thread ? firstLinePreview(latestAssistantText(thread)) : null;
  if (phase === "failed") {
    return firstLinePreview(
      thread?.error ?? launchFailureText ?? (thread ? latestAssistantText(thread) : null),
    );
  }
  return null;
}

function rowTiming(
  phase: SubagentRunPhase,
  launchedAt: string | null,
  thread: SubagentRunThread | undefined,
  reportedEndAt: string | null = null,
  background = false,
): { startedAtMs: number | null; endedAtMs: number | null } {
  const startedAtMs =
    parseTimeMs(launchedAt) ??
    parseTimeMs(thread?.latestTurn?.startedAt) ??
    parseTimeMs(thread?.createdAt);
  // The parent's own report of the end wins; a background child's turn ends at
  // launch, so its thread's turn end says nothing about the subagent.
  const endedAtMs = isTerminalPhase(phase)
    ? (parseTimeMs(reportedEndAt) ??
      (background ? null : parseTimeMs(thread?.latestTurn?.completedAt)))
    : null;
  return {
    startedAtMs,
    endedAtMs:
      startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs ? null : endedAtMs,
  };
}

function providerThreadIdFromChildId(childThreadId: string, rootThreadId: string | null): string {
  const prefix = rootThreadId ? `subagent:${rootThreadId}:` : null;
  return prefix && childThreadId.startsWith(prefix)
    ? childThreadId.slice(prefix.length)
    : childThreadId;
}

function nestedRowsFor(input: {
  spawningThreadId: ThreadId;
  threads: ReadonlyArray<SubagentRunThread>;
  rootThreadId: ThreadId | null;
  visited: Set<string>;
  launchTurnLive: boolean;
  window: InvocationWindow;
}): SubagentRunRow[] {
  return input.threads
    .filter(
      (thread) =>
        thread.sourceThreadId === input.spawningThreadId &&
        thread.id !== input.spawningThreadId &&
        withinInvocation(thread.createdAt, input.window) &&
        !input.visited.has(thread.id),
    )
    .toSorted((left, right) => (left.createdAt < right.createdAt ? -1 : 1))
    .map((child) => {
      const thread = threadForInvocation(child, input.window);
      input.visited.add(thread.id);
      const statusKind = resolveSubagentThreadStatusKind(thread);
      const nested = nestedRowsFor({ ...input, spawningThreadId: thread.id });
      const ownPhase =
        phaseFromStatusKind(statusKind, null) ?? (input.launchTurnLive ? "running" : "done");
      const phase = ownPhase === "running" && nested.some(isRowLive) ? "waiting" : ownPhase;
      const presentation = resolveSubagentPresentationForThread({ thread, threads: input.threads });
      const statusLabel = humanizeSubagentStatus(statusKind);
      const item: ComposerSubagentStripItem = {
        kind: "subagent",
        key: thread.id,
        threadId: thread.id,
        providerThreadId: providerThreadIdFromChildId(thread.id, input.rootThreadId),
        primaryLabel: presentation.nickname ?? presentation.primaryLabel,
        fullLabel: presentation.fullLabel,
        role: presentation.role,
        modelLabel: formatSubagentModelLabel(thread.modelSelection.model),
        statusLabel,
        statusKind,
        isActive: statusKind === "running",
        isViewed: false,
        isBackground: false,
      };
      return {
        key: thread.id,
        item,
        threadId: thread.id,
        phase,
        ...rowTiming(phase, null, thread),
        action: latestChildAction(thread),
        outcomeText: outcomeTextFor(phase, thread),
        nested,
      };
    });
}

function isRowLive(row: SubagentRunRow): boolean {
  return row.phase === "running" || row.phase === "waiting" || row.phase === "starting";
}

function flattenRows(rows: ReadonlyArray<SubagentRunRow>): SubagentRunRow[] {
  return rows.flatMap((row) => [row, ...flattenRows(row.nested)]);
}

function taskEndForLaunch(
  end: SubagentTaskEnd | undefined,
  launchedAt: string | undefined,
  nextLaunchedAt?: string,
) {
  const launchedAtMs = parseTimeMs(launchedAt);
  const nextLaunchedAtMs = parseTimeMs(nextLaunchedAt);
  if (launchedAtMs === null) return end;
  let matching: SubagentTaskEnd | undefined;
  for (let candidate = end; candidate; candidate = candidate.previous) {
    const endedAtMs = parseTimeMs(candidate.endedAt);
    if (
      endedAtMs !== null &&
      endedAtMs >= launchedAtMs &&
      (nextLaunchedAtMs === null || endedAtMs < nextLaunchedAtMs)
    )
      matching = candidate;
  }
  return matching;
}

export function deriveSubagentRunCard(input: {
  subagents: ReadonlyArray<WorkLogSubagent>;
  run: WorkLogSubagentRun;
  threads: ReadonlyArray<SubagentRunThread>;
  /** The thread whose transcript shows the card (the subagents' parent). */
  parentThreadId: ThreadId | null;
  backgroundedProviderThreadIds?: ReadonlySet<string>;
  /** False once the turn that launched them is over (defaults to live). */
  launchTurnLive?: boolean;
  /** Parent-side task completions, keyed by launching tool call id. */
  taskEndByToolUseId?: ReadonlyMap<string, SubagentTaskEnd>;
}): SubagentRunCardModel {
  const launchTurnLive = input.launchTurnLive ?? true;
  const threadById = new Map(input.threads.map((thread) => [thread.id as string, thread]));
  const memberByKey = new Map(input.run.members.map((member) => [member.key, member]));
  const backgrounded = input.backgroundedProviderThreadIds ?? new Set<string>();
  const visited = new Set<string>();

  const rows = input.subagents.map((subagent): SubagentRunRow => {
    const key = subagent.threadId;
    const member = memberByKey.get(key);
    const child =
      threadById.get(subagent.resolvedThreadId ?? "") ??
      (input.parentThreadId
        ? threadById.get(`subagent:${input.parentThreadId}:${subagent.providerThreadId ?? key}`)
        : undefined);
    const taskEnd = taskEndForLaunch(
      input.taskEndByToolUseId?.get(subagent.providerThreadId ?? key),
      member?.launchedAt,
      member?.nextLaunchedAt,
    );
    const window: InvocationWindow = {
      startedAtMs: parseTimeMs(member?.launchedAt),
      endedAtMs: parseTimeMs(taskEnd?.endedAt ?? member?.settledAt),
      beforeMs: parseTimeMs(member?.nextLaunchedAt),
    };
    const thread = child ? threadForInvocation(child, window) : undefined;
    const stripItem = toSubagentStripItem(key, subagent, backgrounded, null);
    // A launch that did not name a model runs on the child's own selection.
    const item =
      stripItem.modelLabel === undefined && thread
        ? { ...stripItem, modelLabel: formatSubagentModelLabel(thread.modelSelection.model) }
        : stripItem;
    if (thread) visited.add(thread.id);
    const nested = thread
      ? nestedRowsFor({
          spawningThreadId: thread.id,
          threads: input.threads,
          rootThreadId: input.parentThreadId,
          visited,
          launchTurnLive,
          window,
        })
      : [];
    const ownPhase =
      directRowPhase({
        subagent,
        member,
        thread,
        launchTurnLive,
        taskEnd,
        background: item.isBackground,
      }) ?? "starting";
    const phase = ownPhase === "running" && nested.some(isRowLive) ? "waiting" : ownPhase;
    const childAction = thread ? latestChildAction(thread) : null;
    return {
      key,
      item,
      threadId:
        thread?.id ??
        (subagent.resolvedThreadId ? ThreadId.makeUnsafe(subagent.resolvedThreadId) : null),
      phase,
      ...rowTiming(
        phase,
        member?.launchedAt ?? null,
        thread,
        taskEnd?.endedAt ?? member?.settledAt ?? null,
        item.isBackground,
      ),
      action: childAction ?? actionFromStep(member?.latestStep ?? null),
      outcomeText: outcomeTextFor(phase, thread, member?.failure ?? null),
      nested,
    };
  });

  const allRows = flattenRows(rows);
  const counts: SubagentRunCounts = { running: 0, done: 0, failed: 0, stopped: 0, interrupted: 0 };
  for (const row of allRows) {
    if (isRowLive(row)) counts.running += 1;
    else if (row.phase === "done") counts.done += 1;
    else if (row.phase === "failed") counts.failed += 1;
    else if (row.phase === "interrupted") counts.interrupted += 1;
    else counts.stopped += 1;
  }
  const startTimes = allRows.flatMap((row) => (row.startedAtMs !== null ? [row.startedAtMs] : []));
  const endTimes = allRows.flatMap((row) => (row.endedAtMs !== null ? [row.endedAtMs] : []));
  const isLive = counts.running > 0;
  return {
    rows,
    nestedCount: allRows.length - rows.length,
    counts,
    isLive,
    allStopped: !isLive && allRows.length > 0 && counts.stopped === allRows.length,
    startedAtMs: startTimes.length > 0 ? Math.min(...startTimes) : null,
    endedAtMs: !isLive && endTimes.length > 0 ? Math.max(...endTimes) : null,
  };
}

// ── Presentation ─────────────────────────────────────────────────────────────

export function subagentRunPhaseStatusKind(phase: SubagentRunPhase): SubagentStatusKind {
  switch (phase) {
    case "running":
    case "waiting":
      return "running";
    case "starting":
      return "queued";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "interrupted":
      return "stopped";
  }
}

function elapsedLabel(
  startedAtMs: number | null,
  endedAtMs: number | null,
  live: boolean,
  nowMs: number,
): string | null {
  if (startedAtMs === null) return null;
  const end = live ? nowMs : endedAtMs;
  return end === null ? null : formatClockDuration(Math.max(0, end - startedAtMs));
}

export type SubagentRunRowDetail =
  | { kind: "action"; action: SubagentRunAction }
  | { kind: "outcome"; text: string }
  | { kind: "was-running"; action: SubagentRunAction };

export interface SubagentRunRowDescription {
  statusKind: SubagentStatusKind;
  /** Present tense while live, past tense once it ended. */
  word: string;
  durationLabel: string | null;
  detail: SubagentRunRowDetail | null;
}

export function describeSubagentRunRow(
  row: SubagentRunRow,
  options: { nowMs: number; allStopped: boolean },
): SubagentRunRowDescription {
  const live = isRowLive(row);
  const durationLabel = elapsedLabel(row.startedAtMs, row.endedAtMs, live, options.nowMs);
  const statusKind = subagentRunPhaseStatusKind(row.phase);
  switch (row.phase) {
    case "starting":
      return { statusKind, word: "Starting", durationLabel: null, detail: null };
    case "running":
      return {
        statusKind,
        word: "Running",
        durationLabel,
        detail: row.action ? { kind: "action", action: row.action } : null,
      };
    case "waiting": {
      const liveNested = row.nested.filter(isRowLive).length;
      return {
        statusKind,
        word: `Waiting for its ${liveNested === 1 ? "subagent" : "subagents"}`,
        durationLabel,
        detail: null,
      };
    }
    case "done":
      return {
        statusKind,
        word: "Done",
        durationLabel,
        detail: row.outcomeText ? { kind: "outcome", text: row.outcomeText } : null,
      };
    case "failed":
      return {
        statusKind,
        word: "Failed",
        durationLabel,
        detail: row.outcomeText ? { kind: "outcome", text: row.outcomeText } : null,
      };
    case "stopped":
    case "interrupted":
      return {
        statusKind,
        word: row.phase === "interrupted" ? "Interrupted" : "Stopped",
        durationLabel,
        detail: row.action ? { kind: "was-running", action: row.action } : null,
      };
  }
}

export interface SubagentRunHeaderDescription {
  title: string;
  nestedLabel: string | null;
  segments: ReadonlyArray<{ text: string; tone: "running" | "failed" | null }>;
  durationLabel: string | null;
}

// "2 subagents · 1 running · 12s" while live; "3 subagents · 1 done · 1 failed
// · 1 stopped · 21s" after, or "· stopped by you ·" when every one was stopped.
// Only the running and failed counts take a hue.
export function describeSubagentRunHeader(
  card: SubagentRunCardModel,
  nowMs: number,
): SubagentRunHeaderDescription {
  const segments: Array<{ text: string; tone: "running" | "failed" | null }> = [];
  if (card.isLive) {
    segments.push({ text: `${card.counts.running} running`, tone: "running" });
  } else if (card.allStopped) {
    segments.push({ text: "stopped", tone: null });
  } else {
    if (card.counts.done > 0) segments.push({ text: `${card.counts.done} done`, tone: null });
    if (card.counts.failed > 0)
      segments.push({ text: `${card.counts.failed} failed`, tone: "failed" });
    if (card.counts.stopped > 0)
      segments.push({ text: `${card.counts.stopped} stopped`, tone: null });
    if (card.counts.interrupted > 0)
      segments.push({ text: `${card.counts.interrupted} interrupted`, tone: null });
  }
  return {
    title: `${card.rows.length} ${pluralize(card.rows.length, "subagent")}`,
    nestedLabel: card.nestedCount > 0 ? `+${card.nestedCount} nested` : null,
    segments,
    durationLabel: elapsedLabel(card.startedAtMs, card.endedAtMs, card.isLive, nowMs),
  };
}

export function collectLiveSubagentRunItems(
  rows: ReadonlyArray<SubagentRunRow>,
): ComposerSubagentStripItem[] {
  return flattenRows(rows)
    .filter(isRowLive)
    .map((row) => row.item);
}

/** Whether the turn that launched a card's subagents is still in progress. */
export function isLaunchTurnLive(
  entry: Pick<WorkLogEntry, "turnId">,
  liveTurnId: TurnId | null | undefined,
): boolean {
  return !entry.turnId || entry.turnId === liveTurnId;
}

/**
 * The newest card that still has a subagent at work, for the floating
 * "N running" chip: its entry id (to scroll to) and how many of its direct
 * subagents are running.
 */
export function findLatestRunningSubagentRun(input: {
  entries: ReadonlyArray<WorkLogEntry>;
  threads: ReadonlyArray<SubagentRunThread>;
  parentThreadId: ThreadId | null;
  /** The parent turn still in progress, if any. */
  liveTurnId: TurnId | null;
  taskEndByToolUseId?: ReadonlyMap<string, SubagentTaskEnd>;
  backgroundedProviderThreadIds?: ReadonlySet<string>;
}): { entryId: string; runningCount: number } | null {
  for (let index = input.entries.length - 1; index >= 0; index -= 1) {
    const entry = input.entries[index]!;
    if (!entry.subagentRun) continue;
    const { counts } = deriveSubagentRunCard({
      subagents: entry.subagents ?? [],
      run: entry.subagentRun,
      threads: input.threads,
      parentThreadId: input.parentThreadId,
      launchTurnLive: isLaunchTurnLive(entry, input.liveTurnId),
      ...(input.taskEndByToolUseId ? { taskEndByToolUseId: input.taskEndByToolUseId } : {}),
      ...(input.backgroundedProviderThreadIds
        ? { backgroundedProviderThreadIds: input.backgroundedProviderThreadIds }
        : {}),
    });
    if (counts.running > 0) {
      return { entryId: entry.id, runningCount: counts.running };
    }
  }
  return null;
}

/** A child's own view shares the outcome and clock its launching card reports. */
export function findLatestSubagentThreadRun(
  input: Parameters<typeof findLatestRunningSubagentRun>[0] & { childThreadId: ThreadId },
): SubagentRunRow | null {
  for (let index = input.entries.length - 1; index >= 0; index -= 1) {
    const entry = input.entries[index]!;
    if (!entry.subagentRun) continue;
    const card = deriveSubagentRunCard({
      subagents: entry.subagents ?? [],
      run: entry.subagentRun,
      threads: input.threads,
      parentThreadId: input.parentThreadId,
      launchTurnLive: isLaunchTurnLive(entry, input.liveTurnId),
      ...(input.taskEndByToolUseId ? { taskEndByToolUseId: input.taskEndByToolUseId } : {}),
      ...(input.backgroundedProviderThreadIds
        ? { backgroundedProviderThreadIds: input.backgroundedProviderThreadIds }
        : {}),
    });
    const row = flattenRows(card.rows).find(
      (candidate) => candidate.threadId === input.childThreadId,
    );
    if (row) return row;
  }
  return null;
}
