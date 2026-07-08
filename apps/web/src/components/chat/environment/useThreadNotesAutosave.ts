// FILE: useThreadNotesAutosave.ts
// Purpose: Own the notepad debounce/save/reconcile lifecycle for one thread instance.
// Layer: Environment panel hook
// Exports: useThreadNotesAutosave

import { useCallback, useEffect, useRef, useState, type ChangeEventHandler } from "react";
import type { ThreadId } from "@synara/contracts";

const DEFAULT_NOTES_AUTOSAVE_DEBOUNCE_MS = 500;

interface UseThreadNotesAutosaveInput {
  readonly threadId: ThreadId;
  readonly notes: string;
  readonly onChange: (threadId: ThreadId, notes: string) => Promise<void>;
  readonly debounceMs?: number;
}

interface UseThreadNotesAutosaveResult {
  readonly value: string;
  readonly onChange: ChangeEventHandler<HTMLTextAreaElement>;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
}

interface PendingLocalEcho {
  readonly value: string;
  readonly staleServerValue: string;
}

// Serializes note writes and reconciles server echoes without clobbering active typing.
export function useThreadNotesAutosave({
  threadId,
  notes,
  onChange,
  debounceMs = DEFAULT_NOTES_AUTOSAVE_DEBOUNCE_MS,
}: UseThreadNotesAutosaveInput): UseThreadNotesAutosaveResult {
  const [value, setValue] = useState(notes);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const retryAfterInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const lastCommittedRef = useRef(notes);
  const lastObservedServerNotesRef = useRef(notes);
  const pendingLocalEchoRef = useRef<PendingLocalEcho | null>(null);
  const valueRef = useRef(value);
  const threadIdRef = useRef(threadId);
  const onChangeRef = useRef(onChange);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    onChangeRef.current = onChange;
    threadIdRef.current = threadId;
  }, [onChange, threadId]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const scheduleFlush = useCallback((delayMs: number) => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void flushRef.current().catch(() => undefined);
    }, delayMs);
  }, []);

  const flush = useCallback(async () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (saveInFlightRef.current) {
      retryAfterInFlightRef.current = true;
      return;
    }
    const next = valueRef.current;
    if (next === lastCommittedRef.current) {
      return;
    }
    saveInFlightRef.current = true;
    let saved = false;
    try {
      await onChangeRef.current(threadIdRef.current, next);
      saved = true;
      lastCommittedRef.current = next;
      pendingLocalEchoRef.current = {
        value: next,
        staleServerValue: lastObservedServerNotesRef.current,
      };
    } finally {
      saveInFlightRef.current = false;
      const shouldFlushQueued =
        retryAfterInFlightRef.current &&
        valueRef.current !== lastCommittedRef.current &&
        (saved || !mountedRef.current);
      retryAfterInFlightRef.current = false;
      if (shouldFlushQueued) {
        if (mountedRef.current) {
          scheduleFlush(debounceMs);
        } else {
          void flushRef.current().catch(() => undefined);
        }
      }
    }
  }, [debounceMs, scheduleFlush]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    lastObservedServerNotesRef.current = notes;
    const pendingLocalEcho = pendingLocalEchoRef.current;
    if (pendingLocalEcho !== null && notes === pendingLocalEcho.value) {
      pendingLocalEchoRef.current = null;
    }
    const waitingForLocalEcho =
      pendingLocalEchoRef.current !== null &&
      valueRef.current === pendingLocalEchoRef.current.value &&
      notes === pendingLocalEchoRef.current.staleServerValue;
    if (
      !focused &&
      debounceRef.current === null &&
      !saveInFlightRef.current &&
      notes !== value &&
      !waitingForLocalEcho
    ) {
      pendingLocalEchoRef.current = null;
      valueRef.current = notes;
      lastCommittedRef.current = notes;
      setValue(notes);
    }
  }, [notes, focused, value]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void flush().catch(() => undefined);
    };
  }, [flush]);

  const handleChange = useCallback<ChangeEventHandler<HTMLTextAreaElement>>(
    (event) => {
      const nextValue = event.target.value;
      // Keep the ref ahead of React state so immediate unmount still flushes the last keystroke.
      valueRef.current = nextValue;
      setValue(nextValue);
      scheduleFlush(debounceMs);
    },
    [debounceMs, scheduleFlush],
  );

  const handleFocus = useCallback(() => {
    setFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    setFocused(false);
    void flush().catch(() => undefined);
  }, [flush]);

  return {
    value,
    onChange: handleChange,
    onFocus: handleFocus,
    onBlur: handleBlur,
  };
}
