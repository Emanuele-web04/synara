// FILE: useBotThread.ts
// Purpose: What a bot's thread on the SynBot page reads from Synara: the thread (its detail
//          subscribed while it shows), its rows (botThread.logic.ts over Synara's timeline
//          entries and the bot's Hub tasks), whether the bot is answering and what it is doing.
//          Sending, stopping and the queue are Synara's composer's (ChatView).
// Layer: SynBot thread hooks
// Exports: BotThread, useBotThread, useBotAnswering

import type { Bot, HubWorkItem, ThreadId } from "@synara/contracts";
import { useEffect, useMemo } from "react";

import { derivePhase } from "~/session-logic";
import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";
import {
  buildBotThreadRows,
  latestWorkStep,
  replyStreaming,
  type BotThreadRow,
} from "~/synbot/botThread.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { deriveTimelineEntries, deriveWorkLogEntries } from "~/workLog";

const EMPTY_TASKS: readonly HubWorkItem[] = [];

/** The bot's chat runs a turn (the face works, the typing row shows). */
export function useBotAnswering(threadId: ThreadId): boolean {
  return useStore((state) => {
    const phase = derivePhase(state.threadSessionById?.[threadId] ?? null);
    return phase === "running" || phase === "connecting";
  });
}

export function useBotThread(bot: Bot) {
  const threadId: ThreadId = bot.threadId;
  // Messages and activities stream only for subscribed threads.
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const allTasks = useSynbotStore((store) => store.data.tasks);
  const delegations = useSynbotStore((store) => store.data.delegations);
  const tasks = useMemo(() => {
    const own = allTasks
      .filter((entry) => entry.task.sourceThreadId === threadId)
      .map((entry) => entry.task);
    return own.length > 0 ? own : EMPTY_TASKS;
  }, [allTasks, threadId]);

  const activeTurnId = thread?.session?.activeTurnId ?? null;
  const entries = useMemo(() => {
    if (!thread) return [];
    const work = deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId, {
      activeTurnId,
      latestTurnState: thread.latestTurn?.state ?? null,
    });
    return deriveTimelineEntries(thread.messages, thread.proposedPlans, work, {
      suppressCoordinatorCheckins: true,
    });
  }, [activeTurnId, thread]);
  const rows: BotThreadRow[] = useMemo(
    () =>
      buildBotThreadRows({
        entries,
        tasks,
        briefOf: (id) => delegations.find((delegation) => delegation.id === id)?.brief ?? null,
      }),
    [delegations, entries, tasks],
  );

  const phase = derivePhase(thread?.session ?? null);
  const running = phase === "running" || phase === "connecting";
  const step = running ? latestWorkStep(entries, activeTurnId) : null;
  const answering = running && !replyStreaming(rows);
  return { thread, threadId, rows, tasks, running, answering, step };
}

export type BotThread = ReturnType<typeof useBotThread>;
