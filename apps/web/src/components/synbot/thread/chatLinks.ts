// FILE: chatLinks.ts
// Purpose: Where a Synara chat embedded in the SynBot page (a bot's thread, a task's thread)
//          sends what it cannot show itself: a turn's diff and a browser URL open in that
//          thread's own view with its diff or browser panel, as ChatView does on its own route;
//          a thread link opens the bot's thread when it is a bot's, else the task pane (the user
//          stays on the SynBot page).
// Layer: SynBot thread hooks
// Exports: useEmbeddedChatPanels, useOpenThreadLink

import type { ThreadId, TurnId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { botByThreadId } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";

import { useOpenBot, useOpenTask } from "../synbotNav";

/** A turn's diff and a browser URL of `threadId`'s chat, in that thread's own view. */
export function useEmbeddedChatPanels(threadId: ThreadId) {
  const navigate = useNavigate();
  const openTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) =>
      void navigate({
        to: "/$threadId",
        params: { threadId },
        // A fresh search: the SynBot page's own (`bot`, `task`) means nothing there.
        search: {
          panel: "diff",
          diff: "1",
          diffTurnId: turnId,
          ...(filePath ? { diffFilePath: filePath } : {}),
        },
      }),
    [navigate, threadId],
  );
  // ChatView has already handed the URL to the in-app browser; this shows its panel.
  const openBrowserUrl = useCallback(
    () =>
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: { panel: "browser" },
      }),
    [navigate, threadId],
  );
  return { openTurnDiff, openBrowserUrl };
}

/** A thread link in a bot chat: a bot's own thread opens that bot, any other the task pane. */
export function useOpenThreadLink() {
  const openBot = useOpenBot();
  const openTask = useOpenTask();
  return useCallback(
    (threadId: ThreadId) => {
      const bot = botByThreadId(useSynbotStore.getState().data, threadId);
      if (bot) openBot(bot);
      else openTask(threadId);
    },
    [openBot, openTask],
  );
}
