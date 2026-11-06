// FILE: synbotNotifications.logic.ts
// Purpose: How bot chats ride Synara's thread notifications (SynBot, Beta): a bot's chat and its
//          tasks' threads notify as the bot and open on the SynBot page; a bot's finished turn
//          notifies only once the work it handed out or started has settled, so the hand-off
//          stays quiet and its report or recap notifies; a bot that starts waiting on the user
//          notifies once, named by what it waits for (a Start, an approval, a question, a task).
//          The bot's status is the signal for that: its chat's requests are not loaded unless
//          its chat is open.
// Layer: Web domain logic (no React, no I/O)
// Exports: synbotPageSearch, synbotPageForThread, isBotOnScreen, botHasOpenWork,
//          botsNewlyWaiting, botWaitReason, BotWaitReason

import type { Bot, HubWorkState, ThreadId } from "@synara/contracts";

import type { SynbotData } from "./synbotState.logic";

/** A task in one of these states is still the bot's work in progress. */
const OPEN_TASK_STATES: ReadonlySet<HubWorkState> = new Set([
  "queued",
  "starting",
  "working",
  "waiting",
]);

/** The SynBot page's search for `bot`'s chat (SynBot's is the page without `?bot`). */
export function synbotPageSearch(bot: Pick<Bot, "id" | "kind">): { readonly bot?: string } {
  return bot.kind === "main" ? {} : { bot: bot.id };
}

/**
 * Where a notification about `threadId` opens when a bot owns it: the bot's chat for its own
 * thread, the bot's chat with the task pane for one of its tasks' threads; null otherwise.
 */
export function synbotPageForThread(
  data: SynbotData,
  threadId: string,
): { readonly bot?: string; readonly task?: string } | null {
  const bot = data.bots.find((candidate) => candidate.threadId === threadId);
  if (bot) return synbotPageSearch(bot);
  const entry = data.tasks.find((candidate) => candidate.task.workerThreadId === threadId);
  const owner = entry ? data.bots.find((candidate) => candidate.id === entry.botId) : undefined;
  return owner ? { ...synbotPageSearch(owner), task: threadId } : null;
}

/**
 * Whether the SynBot page shows `bot`'s chat. `pageBot` is the page's `?bot` ("" without one,
 * SynBot's chat), or null when another page is open.
 */
export function isBotOnScreen(bot: Pick<Bot, "id" | "kind">, pageBot: string | null): boolean {
  if (pageBot === null) return false;
  return pageBot === "" ? bot.kind === "main" : pageBot === bot.id;
}

/** `bot` still has work out: a hand-off it sent that has not settled, or an unfinished task. */
export function botHasOpenWork(data: SynbotData, bot: Pick<Bot, "id">): boolean {
  return (
    data.delegations.some(
      (delegation) => delegation.fromBotId === bot.id && delegation.settledAt === null,
    ) ||
    data.tasks.some((entry) => entry.botId === bot.id && OPEN_TASK_STATES.has(entry.task.state))
  );
}

/**
 * Bots that began waiting on the user since `previous` (each bot's last status). A bot not in
 * `previous` is new to this window (a first snapshot after launch) and does not count.
 */
export function botsNewlyWaiting(
  previous: ReadonlyMap<string, Bot["status"]>,
  bots: readonly Bot[],
): readonly Bot[] {
  return bots.filter((bot) => {
    const before = previous.get(bot.id);
    return bot.status === "waiting" && before !== undefined && before !== "waiting";
  });
}

export type BotWaitReason =
  | { readonly kind: "start"; readonly brief: string }
  | { readonly kind: "approval" }
  | { readonly kind: "question" }
  | { readonly kind: "task"; readonly title: string; readonly threadId: ThreadId | null }
  | { readonly kind: "unknown" };

/** What a waiting bot waits for, from the hand-offs, its chat's shell and its tasks. */
export function botWaitReason(
  data: SynbotData,
  bot: Pick<Bot, "id">,
  shell:
    | { readonly hasPendingApprovals?: boolean; readonly hasPendingUserInput?: boolean }
    | undefined,
): BotWaitReason {
  const start = data.delegations.find(
    (delegation) => delegation.toBotId === bot.id && delegation.state === "awaiting-start",
  );
  if (start) return { kind: "start", brief: start.brief };
  if (shell?.hasPendingApprovals) return { kind: "approval" };
  if (shell?.hasPendingUserInput) return { kind: "question" };
  const task = data.tasks.find((entry) => entry.botId === bot.id && entry.task.state === "waiting");
  if (task) return { kind: "task", title: task.task.title, threadId: task.task.workerThreadId };
  return { kind: "unknown" };
}
