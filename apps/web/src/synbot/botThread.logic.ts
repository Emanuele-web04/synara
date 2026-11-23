// FILE: botThread.logic.ts
// Purpose: The rows of a bot's thread on the SynBot page (HoloBot's thread row model,
//          engine/view/thread.ts + thread/fold.ts), built from Synara's timeline entries: a date
//          separator at the start, after an hour's gap and on a new day; messages grouped by side
//          within five minutes; SynBot cards, hand-offs received and task cards among them; worker
//          status rows; failed turns. Each Hub task of the bot shows once, as a card at the place
//          of its latest activity. Tool rows stay out (the typing row says what the bot is
//          doing); SILENT replies and automation check-ins never show, and neither does a
//          delegation's internal prompt (its brief stands in). Also where a hand-off stands once
//          its delegation left the client's snapshot, and whether the running turn is a check-in.
// Layer: Web domain logic (pure)
// Exports: BotThreadRow, buildBotThreadRows, latestWorkStep, replyStreaming,
//          delegationBriefFromPrompt, checkinTurnRunning, batonState, BatonState,
//          withinBatonGrace

import {
  BOT_DELEGATION_MESSAGE_PREFIX,
  type BotDelegationState,
  type HubWorkItem,
  type TurnId,
} from "@synara/contracts";
import {
  isCoordinatorCheckinUserMessage,
  isSilentCoordinatorCheckinReply,
} from "@synara/shared/coordinatorCheckin";

import type { ChatMessage } from "../types";
import type { TimelineEntry, WorkLogEntry, WorkLogSynbotNotice } from "../workLog";

/** A separator follows an hour's silence and opens each new day. */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;
/** Messages from one side within five minutes sit close together. */
const GROUP_MS = 5 * 60 * 1000;

export type BotThreadRow =
  /** A centered date over what follows (`at`: when it is labeled from). */
  | { readonly kind: "separator"; readonly key: string; readonly at: string }
  /** A bubble; `groupStart`: the first of a run from one side (more space above). */
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: ChatMessage;
      readonly groupStart: boolean;
    }
  /** Work another bot handed to this one: its baton with the brief (null when no brief is
   * known: never the internal prompt). `at`: when it arrived. */
  | {
      readonly kind: "from";
      readonly key: string;
      readonly delegationId: string;
      readonly brief: string | null;
      readonly at: string;
    }
  /** A SynBot card (`synbot.*` activity): delegation, choice, report or control line. */
  | {
      readonly kind: "card";
      readonly key: string;
      readonly entryId: string;
      readonly notice: WorkLogSynbotNotice;
    }
  /** A worker status row (a worker notice no task card stands for). */
  | { readonly kind: "system"; readonly key: string; readonly entry: WorkLogEntry }
  /** A turn that failed (or paused at a usage limit), with its recovery. */
  | { readonly kind: "failure"; readonly key: string; readonly entry: WorkLogEntry }
  /** One Hub task of this bot, as a card. */
  | { readonly kind: "task"; readonly key: string; readonly task: HubWorkItem };

type Content = Exclude<BotThreadRow, { kind: "separator" }>;
type Placed = { readonly row: Content; readonly at: number; readonly iso: string };

const parse = (iso: string, fallback: number) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : fallback;
};

const localDay = (ms: number) => {
  const date = new Date(ms);
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
};

const isUserSide = (row: Content) => row.kind === "message" && row.message.role === "user";

/** An assistant message with nothing to show: empty and settled, or the SILENT sentinel. */
function isQuietReply(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.streaming) return false;
  return isSilentCoordinatorCheckinReply(message.text);
}

/** The worker threads a worker notice is about. */
function noticeThreadIds(entry: WorkLogEntry): readonly string[] {
  return entry.synaraWorkerNotice?.threads.map((thread) => thread.threadId) ?? [];
}

const BRIEF_OPEN = "\n\nBrief:\n\n";
const BRIEF_CLOSE = "\n\nOriginal human messages";

/**
 * The brief inside a delegation's internal prompt (the server's renderDelegationMessage: "Brief:"
 * then the brief, then the source messages as one-line JSON), or null when it has another shape.
 */
export function delegationBriefFromPrompt(text: string): string | null {
  const open = text.indexOf(BRIEF_OPEN);
  if (open < 0) return null;
  const start = open + BRIEF_OPEN.length;
  // The JSON after the brief has no raw newlines, so the last marker closes the brief.
  const close = text.lastIndexOf(BRIEF_CLOSE);
  const brief = (close > start ? text.slice(start, close) : "").trim();
  return brief.length > 0 ? brief : null;
}

/** Each delegation's brief from its `synbot.delegation` notices (either thread's copy). */
function noticeBriefs(entries: readonly TimelineEntry[]): ReadonlyMap<string, string> {
  const briefs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "work") continue;
    const notice = entry.entry.synbotNotice;
    if (notice?.kind !== "synbot.delegation") continue;
    const payload = notice.payload as { delegationId?: unknown; brief?: unknown } | null;
    if (typeof payload?.delegationId !== "string" || typeof payload.brief !== "string") continue;
    if (payload.brief.trim()) briefs.set(payload.delegationId, payload.brief);
  }
  return briefs;
}

/**
 * The rows for a bot thread's timeline `entries` (oldest first) and the bot's Hub `tasks`
 * (those this thread started). Delegation briefs come from `briefOf` (the live delegation),
 * then the delegation's notice, then the brief inside its prompt; never the prompt itself.
 */
export function buildBotThreadRows(input: {
  readonly entries: readonly TimelineEntry[];
  readonly tasks: readonly HubWorkItem[];
  readonly briefOf?: (delegationId: string) => string | null;
}): BotThreadRow[] {
  const tasksByWorker = new Map<string, HubWorkItem>();
  for (const task of input.tasks) {
    if (task.workerThreadId) tasksByWorker.set(task.workerThreadId, task);
  }
  const briefs = noticeBriefs(input.entries);
  // Where each task's card goes: its latest folded notice, else when it was created.
  const taskAt = new Map<string, { at: number; iso: string }>(
    input.tasks.map((task) => [task.id, { at: parse(task.createdAt, 0), iso: task.createdAt }]),
  );
  const placed: Placed[] = [];
  const seenMessages = new Set<string>();
  let last = 0;
  for (const entry of input.entries) {
    const at = parse(entry.createdAt, last);
    last = at;
    if (entry.kind === "proposed-plan") continue;
    if (entry.kind === "message" || entry.kind === "message-segment") {
      const message = entry.message;
      // A reply split around tool rows is one bubble here.
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      if (message.role === "system") continue;
      if (message.role === "user" && message.id.startsWith(BOT_DELEGATION_MESSAGE_PREFIX)) {
        const delegationId = message.id.slice(BOT_DELEGATION_MESSAGE_PREFIX.length);
        placed.push({
          row: {
            kind: "from",
            key: `from:${message.id}`,
            delegationId,
            brief:
              input.briefOf?.(delegationId) ??
              briefs.get(delegationId) ??
              delegationBriefFromPrompt(message.text),
            at: entry.createdAt,
          },
          at,
          iso: entry.createdAt,
        });
        continue;
      }
      if (isQuietReply(message)) continue;
      placed.push({
        row: { kind: "message", key: `msg:${message.id}`, message, groupStart: false },
        at,
        iso: entry.createdAt,
      });
      continue;
    }
    const work = entry.entry;
    if (work.synbotNotice) {
      const notice = work.synbotNotice;
      // The target chat shows a delegation as its received baton instead.
      if (notice.kind === "synbot.delegation" && work.id.endsWith(":to")) continue;
      if (notice.kind === "synbot.card.resolved") continue;
      placed.push({
        row: { kind: "card", key: `card:${work.id}`, entryId: work.id, notice },
        at,
        iso: entry.createdAt,
      });
      continue;
    }
    if (work.turnFailure) {
      placed.push({
        row: { kind: "failure", key: `fail:${work.id}`, entry: work },
        at,
        iso: entry.createdAt,
      });
      continue;
    }
    if (work.synaraWorkerNotice) {
      const threadIds = noticeThreadIds(work);
      const folded = threadIds.length > 0 && threadIds.every((id) => tasksByWorker.has(id));
      if (folded) {
        for (const id of threadIds) {
          const task = tasksByWorker.get(id)!;
          const current = taskAt.get(task.id);
          if (!current || current.at <= at) taskAt.set(task.id, { at, iso: entry.createdAt });
        }
        continue;
      }
      placed.push({
        row: { kind: "system", key: `line:${work.id}`, entry: work },
        at,
        iso: entry.createdAt,
      });
    }
    // Tool and reasoning rows stay out of a bot's thread.
  }

  // Task cards join at their place; ties go after what is already there.
  const tasks = input.tasks
    .map((task) => ({
      row: { kind: "task", key: `task:${task.id}`, task } as const,
      ...(taskAt.get(task.id) ?? { at: 0, iso: task.createdAt }),
    }))
    .toSorted((left, right) => left.at - right.at);
  const merged: Placed[] = [];
  let taskIndex = 0;
  for (const item of placed) {
    while (taskIndex < tasks.length && tasks[taskIndex]!.at < item.at) {
      merged.push(tasks[taskIndex]!);
      taskIndex += 1;
    }
    merged.push(item);
  }
  merged.push(...tasks.slice(taskIndex));

  const rows: BotThreadRow[] = [];
  let previous: { readonly row: Content; readonly at: number } | null = null;
  for (const item of merged) {
    const separator =
      previous === null ||
      item.at - previous.at >= SEPARATOR_GAP_MS ||
      localDay(item.at) !== localDay(previous.at);
    if (separator) rows.push({ kind: "separator", key: `sep:${item.row.key}`, at: item.iso });
    if (item.row.kind === "message") {
      const before: Content | null = previous?.row ?? null;
      const groupStart =
        separator ||
        before === null ||
        before.kind !== "message" ||
        isUserSide(before) !== isUserSide(item.row) ||
        item.at - (previous?.at ?? 0) >= GROUP_MS;
      rows.push({ ...item.row, groupStart });
    } else {
      rows.push(item.row);
    }
    previous = { row: item.row, at: item.at };
  }
  return rows;
}

/** What the bot is doing now, for the typing row: the newest tool step of the running turn. */
export function latestWorkStep(
  entries: readonly TimelineEntry[],
  activeTurnId: TurnId | null | undefined,
): string | null {
  if (!activeTurnId) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "work") continue;
    const work = entry.entry;
    if (work.turnId !== activeTurnId) continue;
    if (work.synbotNotice || work.synaraWorkerNotice) continue;
    if (work.tone !== "tool") continue;
    const step = work.displayToolTitle ?? work.toolTitle ?? work.label;
    if (step.trim()) return step;
  }
  return null;
}

/** The reply of the latest turn is streaming in: the typing row gives way to it. */
export function replyStreaming(rows: readonly BotThreadRow[]): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "message") continue;
    if (row.message.role === "user") return false;
    if (row.message.streaming && row.message.text.trim().length > 0) return true;
  }
  return false;
}

/**
 * The running turn is an automation check-in (its SILENT reply never shows, so no typing row
 * either): the newest user message is a check-in's and belongs to that turn (or is not bound
 * to one yet).
 */
export function checkinTurnRunning(
  messages: readonly Pick<ChatMessage, "role" | "dispatchOrigin" | "turnId">[],
  activeTurnId: TurnId | null | undefined,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (!isCoordinatorCheckinUserMessage(message)) return false;
    return message.turnId == null || activeTurnId == null || message.turnId === activeTurnId;
  }
  return false;
}

/** Where a hand-off stands: a delegation state, or "settled" once it is over but unknown. */
export type BatonState = BotDelegationState | "settled";

/** A notice younger than this can arrive before its delegation reaches the snapshot. */
const BATON_GRACE_MS = 60_000;

/** The hand-off was sent so recently that its delegation may not have reached the client. */
export function withinBatonGrace(createdAt: string | null, nowMs: number): boolean {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(created) && nowMs - created < BATON_GRACE_MS;
}

/**
 * Where a hand-off's baton stands. The live delegation's state when the client has it. Without
 * it: waiting while its Start card is open; settled once that card was answered, and settled
 * when the snapshot (the server keeps the latest delegations only) no longer has it, unless the
 * snapshot is still loading or the hand-off is seconds old (then it was just sent).
 */
export function batonState(input: {
  readonly live: BotDelegationState | null;
  readonly startOpen: boolean;
  readonly startAnswered: boolean;
  readonly snapshotReady: boolean;
  readonly createdAt: string | null;
  readonly nowMs: number;
}): BatonState {
  if (input.live) return input.live;
  if (input.startOpen) return "awaiting-start";
  if (input.startAnswered) return "settled";
  return !input.snapshotReady || withinBatonGrace(input.createdAt, input.nowMs)
    ? "sent"
    : "settled";
}
