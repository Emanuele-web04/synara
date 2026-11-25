// FILE: useComposerPrediction.ts
// Purpose: Requests one predicted next message per settled turn for the chat in the main view,
//          retries a request that got no answer a few times, keeps the result in memory, and
//          exposes it to the composer as ghost text and to the accept keys.
// Layer: React hook
// Exports: useComposerPrediction, ComposerPredictionController

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  composerPredictionEntryForResult,
  composerPredictionStore,
  nextComposerPredictionRequest,
  type ComposerPredictionEntry,
  type ComposerPredictionTarget,
  type VisibleComposerPrediction,
} from "~/lib/composerPrediction";
import { readNativeApi } from "~/nativeApi";

export interface ComposerPredictionController {
  /** The prediction the composer shows right now, read at key time. */
  readonly readVisible: () => VisibleComposerPrediction | null;
  /** The live store entry for a key, so a handler never trusts stale render state. */
  readonly readEntry: (key: string) => ComposerPredictionEntry | undefined;
  /**
   * Takes the shown prediction as the draft: it never shows again for that turn, and its
   * text stays as the ghost until the editor holds the draft the caller writes.
   */
  readonly accept: (prediction: VisibleComposerPrediction) => void;
}

export interface UseComposerPredictionResult {
  /** The suggestion Tab or Right Arrow can accept right now, or null. */
  readonly suggestion: string | null;
  /**
   * What the composer draws as ghost text: the acceptable suggestion, or the one just
   * accepted while its draft is on the way into the editor.
   */
  readonly ghost: string | null;
  readonly controller: ComposerPredictionController;
}

export function useComposerPrediction(input: {
  /** Null while predictions are off, the chat is not the main view's, or the turn is unsettled. */
  readonly target: ComposerPredictionTarget | null;
  /** The composer is empty, idle, and writable. */
  readonly canShow: boolean;
  readonly prompt: string;
}): UseComposerPredictionResult {
  const { target, canShow, prompt } = input;
  const key = target?.key ?? null;
  const threadId = target?.threadId ?? null;
  const turnId = target?.turnId ?? null;
  const readKeyEntry = useCallback(
    () => (key === null ? undefined : composerPredictionStore.getState().entries.get(key)),
    [key],
  );
  const entry = useSyncExternalStore(composerPredictionStore.subscribe, readKeyEntry, readKeyEntry);
  // Typing only hides a ready suggestion: it shows again once the composer is empty again.
  const suggestion = canShow && entry?.status === "ready" ? entry.suggestion : null;
  const entryStatus = entry?.status ?? null;
  const unansweredAttempts = entry?.status === "unavailable" ? entry.attempts : 0;

  // The editor writes a controlled draft a beat after React commits it. Dropping the ghost
  // at once would leave the composer empty in between, collapsing it (to the single row)
  // and growing it again, which moves the transcript under a reader at its end. So the
  // accepted text stays the ghost while the draft equals it: the editor only draws the
  // ghost while it is empty, and stops in the same update that writes the draft.
  const [accepted, setAccepted] = useState<VisibleComposerPrediction | null>(null);
  const ghost =
    suggestion ??
    (accepted !== null && accepted.key === key && prompt === accepted.suggestion
      ? accepted.suggestion
      : null);

  // Keydown can arrive right after a commit, before passive effects run.
  const visibleRef = useRef<VisibleComposerPrediction | null>(null);
  useLayoutEffect(() => {
    visibleRef.current = key !== null && suggestion !== null ? { key, suggestion } : null;
  }, [key, suggestion]);

  // One live request per key, started only while the ghost text could show: at once for a
  // new key, and after the next retry delay for one that got no answer. The retry timer
  // belongs to this effect, so a key change, unmount, or a composer that can no longer show
  // the ghost clears it; it starts over once the ghost could show again. A running request
  // is left alone by all of these except leaving the key (below), so typing never cancels it.
  useEffect(() => {
    if (key === null || threadId === null || turnId === null || !canShow) return;
    const store = composerPredictionStore.getState();
    const request = nextComposerPredictionRequest({
      entry: store.entries.get(key),
      settled: store.settledKeys.has(key),
    });
    if (!request) return;
    const scheduledFrom = store.entries.get(key);
    const start = () => {
      // Another mount for the same key may have moved it on while the timer ran.
      const latest = composerPredictionStore.getState();
      if (latest.entries.get(key) !== scheduledFrom || latest.settledKeys.has(key)) return;
      const api = readNativeApi();
      if (!api) return;
      const controller = new AbortController();
      const pending: ComposerPredictionEntry = {
        status: "pending",
        controller,
        attempt: request.attempt,
      };
      composerPredictionStore.getState().setEntry(key, pending);
      // A result only lands if its request is still the live one for this key: a
      // chat/account/turn change, or turning the setting off, has already replaced it.
      const isCurrent = () => composerPredictionStore.getState().entries.get(key) === pending;
      api.server
        .generateComposerPrediction(
          { threadId, expectedTurnId: turnId },
          { signal: controller.signal },
        )
        .then((result) => {
          if (!isCurrent()) return;
          composerPredictionStore
            .getState()
            .setEntry(key, composerPredictionEntryForResult(result, request.attempt));
        })
        .catch(() => {
          // Silent: a dropped connection is no answer, so it is retried like `unavailable`.
          if (!isCurrent()) return;
          composerPredictionStore
            .getState()
            .setEntry(key, composerPredictionEntryForResult({ suggestion: null }, request.attempt));
        });
    };
    if (request.delayMs === 0) {
      start();
      return;
    }
    const timer = setTimeout(start, request.delayMs);
    return () => clearTimeout(timer);
  }, [canShow, key, threadId, turnId, entryStatus, unansweredAttempts]);

  // Leaving the chat, account, or turn (or turning predictions off) aborts and forgets an
  // unfinished request and the retry count of an unanswered one, so coming back asks
  // afresh; a ready or settled one stays for when the user comes back.
  useEffect(() => {
    if (key === null) return;
    return () => {
      const store = composerPredictionStore.getState();
      const current = store.entries.get(key);
      if (current?.status === "pending") current.controller.abort();
      else if (current?.status !== "unavailable") return;
      store.deleteEntry(key);
    };
  }, [key]);

  const readVisible = useCallback(() => visibleRef.current, []);
  const readEntry = useCallback(
    (entryKey: string) => composerPredictionStore.getState().entries.get(entryKey),
    [],
  );
  const accept = useCallback((prediction: VisibleComposerPrediction) => {
    setAccepted(prediction);
    composerPredictionStore.getState().setEntry(prediction.key, { status: "done" });
  }, []);
  const controller = useMemo(
    () => ({ readVisible, readEntry, accept }),
    [accept, readEntry, readVisible],
  );

  return { suggestion, ghost, controller };
}
