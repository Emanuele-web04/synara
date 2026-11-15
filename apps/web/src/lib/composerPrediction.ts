// FILE: composerPrediction.ts
// Purpose: The pure rules behind composer predictions: which settled turn may request one,
//          when the ghost text may show, when a result or an edit discards it, and when Tab
//          accepts it. Also the in-memory store that keeps one entry per key.
// Layer: Web logic (no React, no transport)
// Exports: composerPredictionKey, resolveComposerPredictionTarget, canShowComposerPrediction,
//          shouldAcceptComposerPredictionOnTab, shouldDiscardComposerPredictionAfterEdit,
//          nextComposerPredictionRequest, fitComposerPredictionText, composerPredictionStore

import type { OrchestrationLatestTurn, ThreadId, TurnId } from "@synara/contracts";
import { createStore } from "zustand/vanilla";

/** The key a prediction lives under: host, provider instance (account), thread, and turn. */
export interface ComposerPredictionTarget {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

/**
 * `pending` while the request runs; `ready` once a suggestion arrived; `failed` after the
 * first request error, which may be retried once (a dropped connection is not an answer);
 * `done` when the turn has no suggestion to show anymore (none came back, it failed twice,
 * it was accepted, or the user typed). A `done` key is never requested or shown again.
 */
export type ComposerPredictionEntry =
  | {
      readonly status: "pending";
      readonly controller: AbortController;
      /** True for the single retry after a failed first request. */
      readonly retry: boolean;
    }
  | { readonly status: "ready"; readonly suggestion: string }
  | { readonly status: "failed" }
  | { readonly status: "done" };

export interface VisibleComposerPrediction {
  readonly key: string;
  readonly suggestion: string;
}

/** Shown in the key chip after the ghost text; a key name, not translated copy. */
export const COMPOSER_PREDICTION_ACCEPT_KEY_LABEL = "Tab";

/** Rows the ghost text may wrap to; a longer suggestion ends with an ellipsis on the last one. */
export const COMPOSER_PREDICTION_MAX_ROWS = 3;

const COMPOSER_PREDICTION_ELLIPSIS = "\u2026";

function withEllipsis(text: string): string {
  return `${text.replace(/[\s,;:.\u2013\u2014-]+$/u, "")}${COMPOSER_PREDICTION_ELLIPSIS}`;
}

/**
 * The ghost text to draw for `suggestion`: all of it when `fits` accepts it, otherwise the
 * longest word prefix that fits with a trailing ellipsis (characters only when the first word
 * alone is too long). `fits` must accept shorter candidates whenever it accepts longer ones.
 * Display only: Tab always inserts the full suggestion.
 */
export function fitComposerPredictionText(
  suggestion: string,
  fits: (candidate: string) => boolean,
): string {
  if (fits(suggestion)) return suggestion;
  const words = suggestion.split(" ");
  let low = 1;
  let high = words.length - 1;
  let keptWords = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(withEllipsis(words.slice(0, middle).join(" ")))) {
      keptWords = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (keptWords > 0) return withEllipsis(words.slice(0, keptWords).join(" "));
  const first = words[0] ?? "";
  low = 1;
  high = first.length - 1;
  let keptChars = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(`${first.slice(0, middle)}${COMPOSER_PREDICTION_ELLIPSIS}`)) {
      keptChars = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${first.slice(0, keptChars)}${COMPOSER_PREDICTION_ELLIPSIS}`;
}

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
/** Most settled keys remembered, in memory and in the window's session storage. */
export const COMPOSER_PREDICTION_SETTLED_LIMIT = 256;

const SETTLED_STORAGE_KEY = "synara:composer-prediction-settled:v1";

function readSettledKeys(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      globalThis.sessionStorage?.getItem(SETTLED_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeSettledKeys(keys: ReadonlySet<string>): void {
  try {
    globalThis.sessionStorage?.setItem(SETTLED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage can be unavailable or full; the in-memory set still holds for this page.
  }
}

interface ComposerPredictionStoreState {
  readonly entries: ReadonlyMap<string, ComposerPredictionEntry>;
  /**
   * Keys whose turn is settled for good (`done`). Kept apart from `entries` so eviction and
   * a window reload cannot bring back a suggestion the user already used or typed over.
   * Only these opaque keys are stored; suggestion text never leaves memory.
   */
  readonly settledKeys: ReadonlySet<string>;
  readonly setEntry: (key: string, entry: ComposerPredictionEntry) => void;
  readonly deleteEntry: (key: string) => void;
}

/**
 * One entry per key for the whole window, so a ready or consumed prediction survives a chat
 * remount. Suggestions live in memory only: nothing here reaches localStorage or the composer
 * draft store, and session storage holds just the settled keys.
 */
export const composerPredictionStore = createStore<ComposerPredictionStoreState>()((set) => ({
  entries: new Map(),
  settledKeys: readSettledKeys(),
  setEntry: (key, entry) =>
    set(({ entries, settledKeys }) => {
      const next = new Map(entries);
      next.delete(key);
      next.set(key, entry);
      for (const [oldestKey, oldest] of next) {
        if (next.size <= COMPOSER_PREDICTION_STORE_LIMIT) break;
        if (oldest.status === "pending") oldest.controller.abort();
        next.delete(oldestKey);
      }
      if (entry.status !== "done" || settledKeys.has(key)) return { entries: next };
      const nextSettled = new Set(settledKeys);
      nextSettled.add(key);
      for (const oldestKey of nextSettled) {
        if (nextSettled.size <= COMPOSER_PREDICTION_SETTLED_LIMIT) break;
        nextSettled.delete(oldestKey);
      }
      writeSettledKeys(nextSettled);
      return { entries: next, settledKeys: nextSettled };
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
 * Whether a request may start for a key: never for a settled one, once for a new one, and
 * once more after a failed first request. Null when no request should start.
 */
export function nextComposerPredictionRequest(input: {
  readonly entry: ComposerPredictionEntry | undefined;
  readonly settled: boolean;
}): { readonly retry: boolean } | null {
  if (input.settled) return null;
  if (input.entry === undefined) return { retry: false };
  return input.entry.status === "failed" ? { retry: true } : null;
}

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
