// FILE: synbotStore.ts
// Purpose: The SynBot client store: the live `bots.*` data for the whole window, kept current by
//          the `bots.event` stream (its first event is a snapshot). Not persisted: the server is
//          the source of truth and resends a snapshot on every (re)connect.
// Layer: UI state store
// Exports: useSynbotStore, startSynbotLiveSync, ensureSynbotMain

import type { BotStreamEvent } from "@synara/contracts";
import { create } from "zustand";

import { SYNBOT_ON } from "../betaFeatures";
import { readNativeApi } from "../nativeApi";
import {
  EMPTY_SYNBOT_DATA,
  applyBotStreamEvent,
  snapshotToData,
  type SynbotData,
} from "./synbotState.logic";

/** `unavailable`: the connected host has no SynBot (Stable, or an older Beta). */
export type SynbotStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface SynbotStoreState {
  readonly status: SynbotStatus;
  readonly data: SynbotData;
  readonly error: string | null;
  readonly applyEvent: (event: BotStreamEvent) => void;
  readonly setStatus: (status: SynbotStatus, error?: string | null) => void;
}

export const useSynbotStore = create<SynbotStoreState>()((set) => ({
  status: "idle",
  data: EMPTY_SYNBOT_DATA,
  error: null,
  applyEvent: (event) =>
    set((state) => ({
      data: applyBotStreamEvent(state.data, event),
      status: "ready",
      error: null,
    })),
  setStatus: (status, error = null) => set({ status, error }),
}));

const UNAVAILABLE_PATTERN = /unavailable|METHOD_NOT_FOUND|not found|FEATURE_UNAVAILABLE/i;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

let stopLiveSync: (() => void) | null = null;

/**
 * Listens to the SynBot stream for the lifetime of the window and loads a first snapshot.
 * Safe to call more than once; returns a stop function for tests.
 */
export function startSynbotLiveSync(): () => void {
  if (!SYNBOT_ON) return () => undefined;
  if (stopLiveSync) return stopLiveSync;
  const api = readNativeApi();
  if (!api) return () => undefined;
  const store = useSynbotStore.getState();
  const unsubscribe = api.bots.onEvent((event) => useSynbotStore.getState().applyEvent(event));
  if (store.status === "idle") store.setStatus("loading");
  void api.bots
    .list()
    .then((snapshot) =>
      useSynbotStore.setState({ data: snapshotToData(snapshot), status: "ready", error: null }),
    )
    .catch((error: unknown) => {
      const message = messageOf(error);
      useSynbotStore
        .getState()
        .setStatus(UNAVAILABLE_PATTERN.test(message) ? "unavailable" : "error", message);
    });
  stopLiveSync = () => {
    unsubscribe();
    stopLiveSync = null;
  };
  return stopLiveSync;
}

let ensuringMain: Promise<void> | null = null;

/** Creates the main SynBot on first visit (idempotent on the server). */
export function ensureSynbotMain(): Promise<void> {
  if (!SYNBOT_ON) return Promise.resolve();
  const api = readNativeApi();
  if (!api) return Promise.resolve();
  if (useSynbotStore.getState().data.bots.some((bot) => bot.kind === "main")) {
    return Promise.resolve();
  }
  ensuringMain ??= api.bots
    .ensureMain({})
    .then((bot) => useSynbotStore.getState().applyEvent({ type: "bot-upserted", bot }))
    .catch((error: unknown) => {
      const message = messageOf(error);
      useSynbotStore
        .getState()
        .setStatus(UNAVAILABLE_PATTERN.test(message) ? "unavailable" : "error", message);
    })
    .finally(() => {
      ensuringMain = null;
    });
  return ensuringMain;
}
