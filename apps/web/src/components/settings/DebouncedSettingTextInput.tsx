// FILE: DebouncedSettingTextInput.tsx
// Purpose: Text input that keeps keystrokes in local state and commits to global settings on a
//          debounce (and on blur/unmount). Avoids a full settings commit + monolithic settings
//          route re-render on every keystroke for fields with no live-preview semantics.
// Layer: Settings UI components

import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";

import { Input } from "~/components/ui/input";

type DebouncedSettingTextInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "defaultValue"
> & {
  /** Committed settings value. */
  value: string;
  /** Called with the draft once the debounce elapses, or immediately on blur/unmount. */
  onCommit: (value: string) => void;
  debounceMs?: number;
};

export function DebouncedSettingTextInput({
  value,
  onCommit,
  debounceMs = 200,
  onBlur,
  onFocus,
  ...inputProps
}: DebouncedSettingTextInputProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef(value);
  // Read latest committed value / callback without re-subscribing the commit
  // timer. Mirrored in an effect (not during render) so the component stays
  // eligible for React Compiler; the timer only fires post-commit anyway.
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    valueRef.current = value;
    onCommitRef.current = onCommit;
  }, [value, onCommit]);

  // Sync the field when the committed value changes from elsewhere (e.g. Restore defaults),
  // but never clobber what the user is actively typing.
  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
      latestDraftRef.current = value;
    }
  }, [value]);

  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
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

  // Commit any pending draft if the field unmounts before blur (e.g. closing settings).
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
    <Input
      {...inputProps}
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
