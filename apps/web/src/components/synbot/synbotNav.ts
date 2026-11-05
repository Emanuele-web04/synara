// FILE: synbotNav.ts
// Purpose: Moving around the SynBot page: open a bot's thread (`?bot=`), open a task's thread
//          in the right pane (`?task=`, HoloBot's right-pane task thread), close it.
// Layer: SynBot UI hooks
// Exports: useOpenBot, useOpenTask

import type { Bot, ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** Opens `bot`'s thread (SynBot's is the page without `?bot`). */
export function useOpenBot() {
  const navigate = useNavigate();
  return useCallback(
    (bot: Pick<Bot, "id" | "kind">) =>
      void navigate({ to: "/synbot", search: bot.kind === "main" ? {} : { bot: bot.id } }),
    [navigate],
  );
}

/** Opens a task's own thread in the right pane, or closes it (null). */
export function useOpenTask() {
  const navigate = useNavigate();
  return useCallback(
    (threadId: ThreadId | null) =>
      void navigate({
        to: "/synbot",
        search: (previous: { readonly bot?: string; readonly task?: string }) => ({
          ...(previous.bot ? { bot: previous.bot } : {}),
          ...(threadId ? { task: threadId } : {}),
        }),
      }),
    [navigate],
  );
}
