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

/**
 * `unavailable`: the connected host has no SynBot.
 * `subscription_required`: Stable host requires an active Synara Alto (Pro) subscription.
 */
export type SynbotStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "subscription_required"
  | "error";

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

const UNAVAILABLE_PATTERN =
  /FEATURE_UNAVAILABLE|METHOD_NOT_FOUND|SynBot is available in|SynBot is not available/i;
const SUBSCRIPTION_PATTERN = /SUBSCRIPTION_REQUIRED|Synara Alto/i;

const errorCodeOf = (error: unknown): string | null =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusForError(error: unknown): {
  readonly status: SynbotStatus;
  readonly message: string;
} {
  const code = errorCodeOf(error);
  const message = messageOf(error);
  if (code === "SUBSCRIPTION_REQUIRED" || SUBSCRIPTION_PATTERN.test(message)) {
    return { status: "subscription_required", message };
  }
  if (code === "FEATURE_UNAVAILABLE" || UNAVAILABLE_PATTERN.test(message)) {
    return { status: "unavailable", message };
  }
  return { status: "error", message };
}

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
      const next = statusForError(error);
      useSynbotStore.getState().setStatus(next.status, next.message);
    });
  stopLiveSync = () => {
    unsubscribe();
    stopLiveSync = null;
  };
  return stopLiveSync;
}

/** Re-subscribes and reloads SynBot after account sign-in or Alto plan activation. */
export function restartSynbotLiveSync(): () => void {
  stopLiveSync?.();
  useSynbotStore.getState().setStatus("idle", null);
  return startSynbotLiveSync();
}

let ensuringMain: Promise<void> | null = null;

/** Creates the main SynBot on first visit (idempotent on the server). */
export function ensureSynbotMain(): Promise<void> {
  if (!SYNBOT_ON) return Promise.resolve();
  const api = readNativeApi();
  if (!api) return Promise.resolve();
  const current = useSynbotStore.getState();
  if (
    current.status === "subscription_required" ||
    current.status === "unavailable" ||
    current.data.bots.some((bot) => bot.kind === "main")
  ) {
    return Promise.resolve();
  }
  ensuringMain ??= api.bots
    .ensureMain({})
    .then((bot) => useSynbotStore.getState().applyEvent({ type: "bot-upserted", bot }))
    .catch((error: unknown) => {
      const next = statusForError(error);
      useSynbotStore.getState().setStatus(next.status, next.message);
    })
    .finally(() => {
      ensuringMain = null;
    });
  return ensuringMain;
}
