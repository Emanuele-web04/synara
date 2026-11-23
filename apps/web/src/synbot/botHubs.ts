// FILE: botHubs.ts
// Purpose: Which Hubs are SynBot bots. Every bot is built on a Hub, but bots are listed and
//          opened only on the SynBot page, so the Hubs UI (its sidebar section, the /hubs
//          landing, the Hubs a thread can move to) skips them. Without SynBot (Stable) no Hub is
//          a bot.
// Layer: SynBot state
// Exports: BotProjectIds, botProjectIdsOf, withoutBotHubs, useBotProjectIds, useIsBotProject

import type { Bot, ProjectId } from "@synara/contracts";
import { useEffect, useMemo } from "react";

import { SYNBOT_ON } from "../betaFeatures";
import { startSynbotLiveSync, type SynbotStatus, useSynbotStore } from "./synbotStore";

/** The bots' Hub project ids; null until SynBot's first snapshot says which Hubs are bots. */
export type BotProjectIds = ReadonlySet<ProjectId> | null;

const NO_BOTS: ReadonlySet<ProjectId> = new Set();

export function botProjectIdsOf(
  status: SynbotStatus,
  bots: readonly Pick<Bot, "id">[],
): BotProjectIds {
  if (status === "idle" || status === "loading") return null;
  return bots.length === 0 ? NO_BOTS : new Set(bots.map((bot) => bot.id));
}

/** The Hubs the Hubs UI lists: none until the bots are known, so a bot never flashes in. */
export function withoutBotHubs<T extends { readonly id: ProjectId }>(
  projects: readonly T[],
  botIds: BotProjectIds,
): T[] {
  if (botIds === null) return [];
  return projects.filter((project) => !botIds.has(project.id));
}

export function useBotProjectIds(): BotProjectIds {
  const status = useSynbotStore((store) => store.status);
  const bots = useSynbotStore((store) => store.data.bots);
  useEffect(() => {
    if (SYNBOT_ON) startSynbotLiveSync();
  }, []);
  return useMemo(() => (SYNBOT_ON ? botProjectIdsOf(status, bots) : NO_BOTS), [status, bots]);
}

/** Whether `projectId` is a bot's Hub (false while unknown). */
export function useIsBotProject(projectId: ProjectId | null | undefined): boolean {
  return useSynbotStore(
    (store) =>
      SYNBOT_ON && projectId != null && store.data.bots.some((bot) => bot.id === projectId),
  );
}
