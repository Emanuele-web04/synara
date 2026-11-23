// FILE: synbotActions.ts
// Purpose: SynBot's one-shot actions, shared by the sidebar (its foot and a bot's menu), the bot
//          sheet and the desktop app menu: pin a bot, stop one bot or all of them, remove a bot.
//          Each applies the server's answer to the store and reports failures in a toast. Stop
//          all and Remove ask first, always in SynBot's own confirmation (SynbotConfirmDialog
//          renders the question kept here), whichever surface asked.
// Layer: SynBot client actions (I/O through the native API)
// Exports: setBotPinned, stopBots, removeBot, useSynbotConfirm, SynbotConfirmRequest,
//          askToStopAllBots, askToRemoveBot, cancelSynbotConfirm, confirmSynbotAction

import type { Bot } from "@synara/contracts";
import { create } from "zustand";

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
    const count =
      result.interruptedThreadIds.length +
      result.cancelledTaskIds.length +
      result.cancelledDelegationIds.length;
    toastManager.add({
      type: "success",
      title: bot
        ? t("synbot:stopBotDone", { name: bot.name })
        : count === 0
          ? t("synbot:stopAllNothing")
          : t("synbot:stopAllDone", { count }),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: bot ? t("synbot:stopFailed") : t("synbot:stopAllFailed"),
      description: messageOf(error),
    });
  }
}

/** Removes `bot` on the server and from the store; throws what the server answered. */
export async function removeBot(bot: Pick<Bot, "id">): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  await api.bots.remove({ id: bot.id });
  useSynbotStore.getState().applyEvent({ type: "bot-removed", botId: bot.id });
}

/** What the confirmation asks about: stopping every bot, or removing one. */
export type SynbotConfirmRequest =
  | { readonly kind: "stop-all" }
  | { readonly kind: "remove"; readonly bot: Pick<Bot, "id" | "name"> };

interface SynbotConfirmState {
  /** The open question, or null. */
  readonly request: SynbotConfirmRequest | null;
  /** The answer is being carried out: the question stays open and cannot be dismissed. */
  readonly busy: boolean;
}

export const useSynbotConfirm = create<SynbotConfirmState>()(() => ({
  request: null,
  busy: false,
}));

function ask(request: SynbotConfirmRequest): void {
  if (useSynbotConfirm.getState().busy) return;
  useSynbotConfirm.setState({ request });
}

/** Asks before stopping every bot (the sidebar's Stop all, the app menu's Stop All Bots…). */
export function askToStopAllBots(): void {
  ask({ kind: "stop-all" });
}

/** Asks before removing `bot` (a bot's menu, its sheet). */
export function askToRemoveBot(bot: Pick<Bot, "id" | "name">): void {
  ask({ kind: "remove", bot: { id: bot.id, name: bot.name } });
}

/** Cancel: closes the question unless its answer is already running. */
export function cancelSynbotConfirm(): void {
  if (useSynbotConfirm.getState().busy) return;
  useSynbotConfirm.setState({ request: null });
}

/**
 * Carries out the open question, then closes it (a failure is reported in a toast). Resolves
 * with the id of the bot it removed, or null.
 */
export async function confirmSynbotAction(): Promise<string | null> {
  const { request, busy } = useSynbotConfirm.getState();
  if (!request || busy) return null;
  useSynbotConfirm.setState({ busy: true });
  try {
    if (request.kind === "stop-all") {
      await stopBots();
      return null;
    }
    try {
      await removeBot(request.bot);
      return request.bot.id;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("synbot:removeFailed", { name: request.bot.name }),
        description: messageOf(error),
      });
      return null;
    }
  } finally {
    useSynbotConfirm.setState({ request: null, busy: false });
  }
}
