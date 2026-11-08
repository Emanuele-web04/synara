// FILE: synbotActions.ts
// Purpose: SynBot's one-shot actions, shared by the sidebar (its foot and a bot row's context
//          menu), the bot sheet and the desktop app menu: pin a bot, stop one bot or all of
//          them, remove a bot. Each applies the server's answer to the store and reports
//          failures in a toast; the confirmations use the host's own dialog.
// Layer: SynBot client actions (I/O through the native API)
// Exports: setBotPinned, stopBots, confirmAndStopAllBots, removeBot, confirmAndRemoveBot

import type { Bot } from "@synara/contracts";

import { toastManager } from "~/components/ui/toast";
import { t } from "~/i18n";
import { readNativeApi } from "~/nativeApi";

import { useSynbotStore } from "./synbotStore";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function setBotPinned(bot: Bot, pinned: boolean): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    const next = await api.bots.update({ id: bot.id, expectedRevision: bot.revision, pinned });
    useSynbotStore.getState().applyEvent({ type: "bot-upserted", bot: next });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: t("synbot:pinFailed"),
      description: messageOf(error),
    });
  }
}

/** Stops `bot` (its turn, its tasks and the work handed to it), or every bot without one. */
export async function stopBots(bot?: Pick<Bot, "id" | "name">): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    const result = await api.bots.stopAll(bot ? { botId: bot.id } : {});
    const count = result.interruptedThreadIds.length + result.cancelledTaskIds.length;
    toastManager.add({
      type: "success",
      title: bot ? t("synbot:stopBotDone", { name: bot.name }) : t("synbot:stopAllDone", { count }),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: bot ? t("synbot:stopFailed") : t("synbot:stopAllFailed"),
      description: messageOf(error),
    });
  }
}

/** Asks first (the host's confirm dialog), then stops every bot. */
export async function confirmAndStopAllBots(): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const confirmed = await api.dialogs.confirm(
    [t("synbot:stopAllTitle"), t("synbot:stopAllDescription")].join("\n"),
  );
  if (confirmed) await stopBots();
}

/** Removes `bot` on the server and from the store; throws what the server answered. */
export async function removeBot(bot: Pick<Bot, "id">): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  await api.bots.remove({ id: bot.id });
  useSynbotStore.getState().applyEvent({ type: "bot-removed", botId: bot.id });
}

/** Asks first (the host's confirm dialog), then removes `bot`; true once it is gone. */
export async function confirmAndRemoveBot(bot: Pick<Bot, "id" | "name">): Promise<boolean> {
  const api = readNativeApi();
  if (!api) return false;
  const confirmed = await api.dialogs.confirm(
    [t("synbotEditor:removeTitle", { value0: bot.name }), t("synbotEditor:removeMessage")].join(
      "\n",
    ),
  );
  if (!confirmed) return false;
  try {
    await removeBot(bot);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: t("synbot:removeFailed", { name: bot.name }),
      description: messageOf(error),
    });
    return false;
  }
}
