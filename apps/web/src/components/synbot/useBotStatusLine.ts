// FILE: useBotStatusLine.ts
// Purpose: The one status line under a bot's name (HoloBot's row): what waits on the user,
//          how many tasks run, paused, or the bot's role when it is idle.
// Layer: SynBot UI hook
// Exports: useBotStatusLine

import type { Bot, HubWorkItem } from "@synara/contracts";
import { useCallback } from "react";

import { useTranslation } from "~/i18n";

const ACTIVE_STATES = new Set(["queued", "starting", "working"]);

export function useBotStatusLine() {
  const { t } = useTranslation();
  return useCallback(
    (bot: Bot, tasks: readonly HubWorkItem[]): string => {
      if (bot.status === "paused") return t("synbot:status_paused");
      if (bot.status === "waiting") return t("synbot:status_waiting");
      const running = tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
      if (bot.status === "working") {
        return running > 0
          ? t("synbot:status_workingTasks", { count: running })
          : t("synbot:status_working");
      }
      return bot.role || t("synbot:status_idle");
    },
    [t],
  );
}
