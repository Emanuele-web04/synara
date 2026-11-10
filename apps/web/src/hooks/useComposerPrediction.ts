// FILE: useComposerPrediction.ts
// Purpose: Requests one predicted next message per settled turn for the chat in the main view,
//          keeps it in memory, and exposes it to the composer as ghost text and to Tab.
// Layer: React hook
// Exports: useComposerPrediction, ComposerPredictionController

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  shouldDiscardComposerPredictionAfterEdit,
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
  /** Marks the key's prediction as used; it never shows again for that turn. */
  readonly consume: (key: string) => void;
}

export interface UseComposerPredictionResult {
  /** Ghost text for the composer, or null. */
  readonly suggestion: string | null;
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
  const suggestion = canShow && entry?.status === "ready" ? entry.suggestion : null;

  // Keydown can arrive right after a commit, before passive effects run.
  const visibleRef = useRef<VisibleComposerPrediction | null>(null);
  useLayoutEffect(() => {
    visibleRef.current = key !== null && suggestion !== null ? { key, suggestion } : null;
  }, [key, suggestion]);

  // Typing while a prediction is pending or shown discards it for this turn for good.
  const lastPromptRef = useRef({ key, prompt });
  useLayoutEffect(() => {
    const previous = lastPromptRef.current;
    lastPromptRef.current = { key, prompt };
    if (key === null) return;
    const store = composerPredictionStore.getState();
    const current = store.entries.get(key);
    if (
      !shouldDiscardComposerPredictionAfterEdit({ previous, next: { key, prompt }, entry: current })
    )
      return;
    if (current?.status === "pending") current.controller.abort();
    store.setEntry(key, { status: "done" });
  }, [key, prompt]);

  // One request per key, started only while the ghost text could show.
  useEffect(() => {
    if (key === null || threadId === null || turnId === null || !canShow) return;
    const store = composerPredictionStore.getState();
    const request = nextComposerPredictionRequest({
      entry: store.entries.get(key),
      settled: store.settledKeys.has(key),
    });
    if (!request) return;
    const api = readNativeApi();
    if (!api) return;
    const controller = new AbortController();
    const pending: ComposerPredictionEntry = {
      status: "pending",
      controller,
      retry: request.retry,
    };
    store.setEntry(key, pending);
    // A result only lands if its request is still the live one for this key: an edit,
    // a chat/account/turn change, or turning the setting off has already replaced it.
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
          .setEntry(
            key,
            result.suggestion
              ? { status: "ready", suggestion: result.suggestion }
              : { status: "done" },
          );
      })
      .catch(() => {
        // Failures are silent. The first one may be a dropped connection, so the turn stays
        // open for one more request the next time the composer could show a suggestion.
        if (!isCurrent()) return;
        composerPredictionStore
          .getState()
          .setEntry(key, request.retry ? { status: "done" } : { status: "failed" });
      });
  }, [canShow, key, threadId, turnId]);

  // Leaving the chat, account, or turn (or turning predictions off) aborts and forgets an
  // unfinished request; a finished one stays for when the user comes back.
  useEffect(() => {
    if (key === null) return;
    return () => {
      const store = composerPredictionStore.getState();
      const current = store.entries.get(key);
      if (current?.status !== "pending") return;
      current.controller.abort();
      store.deleteEntry(key);
    };
  }, [key]);

  const readVisible = useCallback(() => visibleRef.current, []);
  const readEntry = useCallback(
    (entryKey: string) => composerPredictionStore.getState().entries.get(entryKey),
    [],
  );
  const consume = useCallback((consumedKey: string) => {
    composerPredictionStore.getState().setEntry(consumedKey, { status: "done" });
  }, []);
  const controller = useMemo(
    () => ({ readVisible, readEntry, consume }),
    [consume, readEntry, readVisible],
  );

  return { suggestion, controller };
}
