// FILE: DebouncedSettingTextarea.tsx
// Purpose: Multiline settings field that commits on debounce/blur like DebouncedSettingTextInput.
// Layer: Settings UI components

import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";

import { Textarea } from "~/components/ui/textarea";

type DebouncedSettingTextareaProps = Omit<
  ComponentProps<typeof Textarea>,
  "value" | "onChange" | "defaultValue"
> & {
  value: string;
  onCommit: (value: string) => void;
  debounceMs?: number;
};

export function DebouncedSettingTextarea({
  value,
  onCommit,
  debounceMs = 300,
  onBlur,
  onFocus,
  ...textareaProps
}: DebouncedSettingTextareaProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
      latestDraftRef.current = value;
    }
  }, [value]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    if (latestDraftRef.current !== valueRef.current) {
      onCommitRef.current(latestDraftRef.current);
    }
  }, [clearTimer]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        if (latestDraftRef.current !== valueRef.current) {
          onCommitRef.current(latestDraftRef.current);
        }
      }
    },
    [],
  );

  return (
    <Textarea
      {...textareaProps}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        latestDraftRef.current = next;
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          onCommitRef.current(next);
        }, debounceMs);
      }}
      onFocus={(event) => {
        focusedRef.current = true;
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        flush();
        onBlur?.(event);
      }}
    />
  );
}
