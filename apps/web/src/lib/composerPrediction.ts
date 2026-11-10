// FILE: composerPrediction.ts
// Purpose: The pure rules behind composer predictions: which settled turn may request one,
//          when the ghost text may show, when a result or an edit discards it, and when Tab
//          accepts it. Also the in-memory store that keeps one entry per key.
// Layer: Web logic (no React, no transport)
// Exports: composerPredictionKey, resolveComposerPredictionTarget, canShowComposerPrediction,
//          shouldAcceptComposerPredictionOnTab, shouldDiscardComposerPredictionAfterEdit,
//          composerPredictionStore

import type { OrchestrationLatestTurn, ThreadId, TurnId } from "@synara/contracts";
import { createStore } from "zustand/vanilla";

/** The key a prediction lives under: host, provider instance (account), thread, and turn. */
export interface ComposerPredictionTarget {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

/**
 * `pending` while the request runs; `ready` once a suggestion arrived; `done` when the turn
 * has no suggestion to show anymore (none came back, it failed, it was accepted, or the user
 * typed). A `done` entry is never requested or shown again for its key.
 */
export type ComposerPredictionEntry =
  | { readonly status: "pending"; readonly controller: AbortController }
  | { readonly status: "ready"; readonly suggestion: string }
  | { readonly status: "done" };

export interface VisibleComposerPrediction {
  readonly key: string;
  readonly suggestion: string;
}

/** Shown in the key chip after the ghost text; a key name, not translated copy. */
export const COMPOSER_PREDICTION_ACCEPT_KEY_LABEL = "Tab";

export function composerPredictionKey(input: {
  readonly hostId: string | null;
  readonly providerInstanceId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}): string {
  return JSON.stringify([input.hostId, input.providerInstanceId, input.threadId, input.turnId]);
}

/**
 * The turn a prediction may be requested for: the latest turn completed with its final
 * reply in place and nothing still streaming. Null when predictions are off or the turn
 * is not settled yet.
 */
export function resolveComposerPredictionTarget(input: {
  readonly enabled: boolean;
  readonly hostId: string | null;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null | undefined;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "completedAt" | "assistantMessageId"
  > | null;
  readonly latestTurnSettled: boolean;
  readonly hasStreamingAssistant: boolean;
}): ComposerPredictionTarget | null {
  const turn = input.latestTurn;
  if (
    !input.enabled ||
    !input.threadId ||
    !input.providerInstanceId ||
    !turn ||
    turn.state !== "completed" ||
    turn.completedAt === null ||
    turn.assistantMessageId === null ||
    !input.latestTurnSettled ||
    input.hasStreamingAssistant
  ) {
    return null;
  }
  return {
    key: composerPredictionKey({
      hostId: input.hostId,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      turnId: turn.turnId,
    }),
    threadId: input.threadId,
    turnId: turn.turnId,
  };
}

/** The ghost text belongs to an empty, idle, writable composer and nowhere else. */
export function canShowComposerPrediction(input: {
  readonly prompt: string;
  readonly hasAttachments: boolean;
  readonly menuOpen: boolean;
  readonly hasLiveTurn: boolean;
  readonly hasQueuedTurns: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isApprovalState: boolean;
  readonly isReadOnly: boolean;
}): boolean {
  return (
    input.prompt.length === 0 &&
    !input.hasAttachments &&
    !input.menuOpen &&
    !input.hasLiveTurn &&
    !input.hasQueuedTurns &&
    !input.hasPendingUserInput &&
    !input.isApprovalState &&
    !input.isReadOnly
  );
}

/**
 * Tab takes the suggestion only when, on the editor's current state, the composer is
 * focused and empty, the suggestion is still the ready one for the current key, no
 * modifier is held, and no IME composition is running. Anything else keeps Tab's
 * normal behavior.
 */
export function shouldAcceptComposerPredictionOnTab(input: {
  readonly event: Pick<
    KeyboardEvent,
    "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode"
  >;
  readonly editorFocused: boolean;
  readonly snapshot: {
    readonly value: string;
    readonly terminalContextIds: ReadonlyArray<string>;
  } | null;
  readonly prediction: VisibleComposerPrediction | null;
  readonly entry: ComposerPredictionEntry | undefined;
}): boolean {
  const { event, prediction, snapshot } = input;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (!input.editorFocused || !snapshot || !prediction) return false;
  if (snapshot.value.length > 0 || snapshot.terminalContextIds.length > 0) return false;
  return input.entry?.status === "ready" && input.entry.suggestion === prediction.suggestion;
}

/** Most entries the store keeps; the oldest key is forgotten first. */
export const COMPOSER_PREDICTION_STORE_LIMIT = 64;

interface ComposerPredictionStoreState {
  readonly entries: ReadonlyMap<string, ComposerPredictionEntry>;
  readonly setEntry: (key: string, entry: ComposerPredictionEntry) => void;
  readonly deleteEntry: (key: string) => void;
}

/**
 * One entry per key for the whole window, so a ready or consumed prediction survives a chat
 * remount. In memory only: nothing here reaches localStorage or the composer draft store.
 */
export const composerPredictionStore = createStore<ComposerPredictionStoreState>()((set) => ({
  entries: new Map(),
  setEntry: (key, entry) =>
    set(({ entries }) => {
      const next = new Map(entries);
      next.delete(key);
      next.set(key, entry);
      for (const [oldestKey, oldest] of next) {
        if (next.size <= COMPOSER_PREDICTION_STORE_LIMIT) break;
        if (oldest.status === "pending") oldest.controller.abort();
        next.delete(oldestKey);
      }
      return { entries: next };
    }),
  deleteEntry: (key) =>
    set(({ entries }) => {
      if (!entries.has(key)) return {};
      const next = new Map(entries);
      next.delete(key);
      return { entries: next };
    }),
}));

/**
 * Whether a prompt change discards the prediction for the same key: any edit while it is
 * pending or ready means the user is writing their own message, so it never comes back for
 * that turn. A key change (another chat, account, or turn) is not an edit.
 */
export function shouldDiscardComposerPredictionAfterEdit(input: {
  readonly previous: { readonly key: string | null; readonly prompt: string };
  readonly next: { readonly key: string | null; readonly prompt: string };
  readonly entry: ComposerPredictionEntry | undefined;
}): boolean {
  return (
    input.next.key !== null &&
    input.previous.key === input.next.key &&
    input.previous.prompt !== input.next.prompt &&
    (input.entry?.status === "pending" || input.entry?.status === "ready")
  );
}
