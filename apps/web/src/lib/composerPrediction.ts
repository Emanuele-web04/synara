// FILE: composerPrediction.ts
// Purpose: The pure rules behind composer predictions: which settled turn may request one,
//          when the ghost text may show, what a result means for the turn, when a request
//          is retried, and which key accepts it. Also the in-memory store that keeps one
//          entry per key.
// Layer: Web logic (no React, no transport)
// Exports: composerPredictionKey, resolveComposerPredictionInstanceId,
//          resolveComposerPredictionTarget, canShowComposerPrediction,
//          shouldAcceptComposerPrediction, composerPredictionEntryForResult,
//          nextComposerPredictionRequest, fitComposerPredictionText, composerPredictionStore

import type {
  ModelSelection,
  OrchestrationLatestTurn,
  ServerGenerateComposerPredictionResult,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { resolveModelSelectionInstanceId } from "@synara/shared/providerInstances";
import { createStore } from "zustand/vanilla";

/** The key a prediction lives under: host, provider instance (account), thread, and turn. */
export interface ComposerPredictionTarget {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

/**
 * `pending` while a request runs; `ready` once a suggestion arrived (typing only hides it);
 * `unavailable` after a request got no answer (the server could not produce one this time,
 * or the request itself failed), retried on {@link COMPOSER_PREDICTION_RETRY_DELAYS_MS};
 * `done` when the turn has nothing to show anymore (the model answered with no suggestion,
 * or it was accepted). A `done` key is never requested or shown again.
 */
export type ComposerPredictionEntry =
  | {
      readonly status: "pending";
      readonly controller: AbortController;
      /** 1 for the first request for the key, counting up with each retry. */
      readonly attempt: number;
    }
  | { readonly status: "ready"; readonly suggestion: string }
  | {
      readonly status: "unavailable";
      /** Requests that got no answer so far. */
      readonly attempts: number;
      /** A provider may have already run, so only the first request can be retried. */
      readonly limitRetries?: true;
    }
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

/**
 * The provider instance (account) a chat's prediction runs on, resolved the way the server
 * routes it: the live session's instance, else the chat's model selection with its
 * provider standing in for a missing instance id (chats from before instance ids).
 */
export function resolveComposerPredictionInstanceId(
  thread:
    | {
        readonly session?: { readonly providerInstanceId?: string | undefined } | null | undefined;
        readonly modelSelection: Pick<ModelSelection, "provider" | "instanceId">;
      }
    | null
    | undefined,
): string | null {
  if (!thread) return null;
  return (
    thread.session?.providerInstanceId ?? resolveModelSelectionInstanceId(thread.modelSelection)
  );
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
 * Tab or Right Arrow takes the suggestion only when, on the editor's current state, the
 * composer is focused and empty, the suggestion is still the ready one for the current key,
 * no modifier is held, and no IME composition is running. Anything else keeps the key's
 * normal behavior. The caller decides which keys may accept; Enter never does.
 */
export function shouldAcceptComposerPrediction(input: {
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

/**
 * How long to wait before asking again after each request that got no answer. Once these
 * run out the key stays quiet until it is left and entered again.
 */
export const COMPOSER_PREDICTION_RETRY_DELAYS_MS: ReadonlyArray<number> = [2_000, 5_000, 15_000];

/** Most entries the store keeps; the oldest key is forgotten first. */
export const COMPOSER_PREDICTION_STORE_LIMIT = 64;
/** Most settled keys remembered, in memory and in the window's session storage. */
export const COMPOSER_PREDICTION_SETTLED_LIMIT = 256;

// v1 also recorded transient failures and discarded drafts as settled turns.
const SETTLED_STORAGE_KEY = "synara:composer-prediction-settled:v2";

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
   * a window reload cannot bring back a suggestion the user already used, or ask again for
   * a turn the model had nothing for. Only these opaque keys are stored; suggestion text
   * never leaves memory.
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
 * Whether a request may start for a key, and after how long: never for a settled one, at
 * once for a new one, and after the next retry delay for one that got no answer, until
 * the delays run out. Null when no request should start.
 */
export function nextComposerPredictionRequest(input: {
  readonly entry: ComposerPredictionEntry | undefined;
  readonly settled: boolean;
}): { readonly attempt: number; readonly delayMs: number } | null {
  const { entry, settled } = input;
  if (settled) return null;
  if (entry === undefined) return { attempt: 1, delayMs: 0 };
  if (entry.status !== "unavailable" || (entry.limitRetries && entry.attempts >= 2)) return null;
  const delayMs = COMPOSER_PREDICTION_RETRY_DELAYS_MS[entry.attempts - 1];
  return delayMs === undefined ? null : { attempt: entry.attempts + 1, delayMs };
}

/**
 * The entry a request's result leaves: a suggestion is ready to show; the model's own "none"
 * settles the turn. Only a confirmed pre-generation miss gets the full retry schedule.
 * For an older server's bare null or a lost response, the provider may already have run.
 */
export function composerPredictionEntryForResult(
  result: ServerGenerateComposerPredictionResult,
  attempt: number,
): ComposerPredictionEntry {
  if (result.suggestion) return { status: "ready", suggestion: result.suggestion };
  if (result.outcome === "none") return { status: "done" };
  return {
    status: "unavailable",
    attempts: attempt,
    ...(result.outcome === "unavailable" ? {} : { limitRetries: true as const }),
  };
}
