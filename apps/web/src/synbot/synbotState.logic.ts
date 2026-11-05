// FILE: synbotState.logic.ts
// Purpose: Pure SynBot client state: applies `bots.*` stream events to a snapshot and derives
//          what the page shows (sidebar order, attention counts, a bot's tasks and delegations).
// Layer: Web domain logic (no React, no I/O)
// Exports: SynbotData, EMPTY_SYNBOT_DATA, applyBotStreamEvent, orderedBots, botNeedsYou,
//          synbotNeedsYouCount, tasksForBot, delegationsTouchingThread, delegationById

import type {
  Bot,
  BotDelegation,
  BotSettings,
  BotStreamEvent,
  BotsSnapshot,
  HubWorkItem,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { DEFAULT_BOT_SETTINGS } from "@synara/contracts";

export interface SynbotTask {
  readonly botId: ProjectId;
  readonly task: HubWorkItem;
}

export interface SynbotData {
  readonly bots: readonly Bot[];
  readonly settings: BotSettings;
  readonly delegations: readonly BotDelegation[];
  readonly tasks: readonly SynbotTask[];
}

export const EMPTY_SYNBOT_DATA: SynbotData = {
  bots: [],
  settings: DEFAULT_BOT_SETTINGS,
  delegations: [],
  tasks: [],
};

export function snapshotToData(snapshot: BotsSnapshot): SynbotData {
  return {
    bots: snapshot.bots,
    settings: snapshot.settings,
    delegations: snapshot.delegations,
    tasks: snapshot.tasks,
  };
}

const upsertBy = <T>(items: readonly T[], next: T, same: (item: T) => boolean): readonly T[] => {
  const index = items.findIndex(same);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
};

/** Applies one stream event. Older revisions of a task never overwrite newer ones. */
export function applyBotStreamEvent(data: SynbotData, event: BotStreamEvent): SynbotData {
  switch (event.type) {
    case "snapshot":
      return snapshotToData(event.snapshot);
    case "bot-upserted":
      return { ...data, bots: upsertBy(data.bots, event.bot, (bot) => bot.id === event.bot.id) };
    case "bot-removed":
      return {
        ...data,
        bots: data.bots.filter((bot) => bot.id !== event.botId),
        tasks: data.tasks.filter((entry) => entry.botId !== event.botId),
      };
    case "settings-updated":
      return { ...data, settings: event.settings };
    case "delegation-upserted":
      return {
        ...data,
        delegations: upsertBy(
          data.delegations,
          event.delegation,
          (delegation) => delegation.id === event.delegation.id,
        ),
      };
    case "task-upserted": {
      const existing = data.tasks.find((entry) => entry.task.id === event.task.id);
      if (existing && existing.task.revision > event.task.revision) return data;
      return {
        ...data,
        tasks: upsertBy(
          data.tasks,
          { botId: event.botId, task: event.task },
          (entry) => entry.task.id === event.task.id,
        ),
      };
    }
  }
}

const byName = (left: Bot, right: Bot) => left.name.localeCompare(right.name);

/** SynBot first, then pinned bots, then the rest; each group by name. */
export function orderedBots(bots: readonly Bot[]): {
  readonly main: Bot | null;
  readonly pinned: readonly Bot[];
  readonly others: readonly Bot[];
} {
  return {
    main: bots.find((bot) => bot.kind === "main") ?? null,
    pinned: bots.filter((bot) => bot.kind !== "main" && bot.pinned).toSorted(byName),
    others: bots.filter((bot) => bot.kind !== "main" && !bot.pinned).toSorted(byName),
  };
}

export function botNeedsYou(bot: Bot): boolean {
  return bot.status === "waiting";
}

/** The rail badge: bots waiting on the user. */
export function synbotNeedsYouCount(data: SynbotData): number {
  return data.bots.filter(botNeedsYou).length;
}

/** A bot's tasks, newest first. */
export function tasksForBot(data: SynbotData, botId: ProjectId): readonly HubWorkItem[] {
  return data.tasks
    .filter((entry) => entry.botId === botId)
    .map((entry) => entry.task)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Delegations a thread sent or received. */
export function delegationsTouchingThread(
  data: SynbotData,
  threadId: ThreadId,
): readonly BotDelegation[] {
  return data.delegations.filter(
    (delegation) => delegation.fromThreadId === threadId || delegation.toThreadId === threadId,
  );
}

export function delegationById(data: SynbotData, id: string): BotDelegation | null {
  return data.delegations.find((delegation) => delegation.id === id) ?? null;
}

export function botById(data: SynbotData, id: string | null | undefined): Bot | null {
  if (!id) return null;
  return data.bots.find((bot) => bot.id === id) ?? null;
}

export function botByThreadId(data: SynbotData, threadId: string | null | undefined): Bot | null {
  if (!threadId) return null;
  return data.bots.find((bot) => bot.threadId === threadId) ?? null;
}
