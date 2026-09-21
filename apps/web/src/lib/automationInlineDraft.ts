import { useEffect, useRef, useState } from "react";

export interface CommitDraftOptions {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly validate?: ((value: string) => string | null) | undefined;
  readonly normalize?: ((value: string) => string) | undefined;
  // turn OFF for fields whose commit payload depends on sibling state (schedule rows): their unmount usually means that state changed and flushing through the stale closure would resurrect it
  readonly flushOnUnmount?: boolean | undefined;
}

export interface CommitDraft {
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly commit: () => void;
  readonly revert: () => void;
  readonly error: string | null;
}

// draft keyed to its seed value: external changes (stream update, rollback) derive straight back with no sync effect; a valid pending draft flushes on unmount so navigating away never loses an edit
export function useCommitDraft({
  value,
  onCommit,
  validate,
  normalize,
  flushOnUnmount = true,
}: CommitDraftOptions): CommitDraft {
  const [draftState, setDraftState] = useState<{ base: string; value: string } | null>(null);
  const draft = draftState !== null && draftState.base === value ? draftState.value : value;
  const setDraft = (next: string) => setDraftState({ base: value, value: next });

  const normalized = normalize ? normalize(draft) : draft;
  const isCommittable = normalized !== value && (!validate || validate(normalized) === null);
  const latest = useRef({ isCommittable, normalized, onCommit, flushOnUnmount });

  const clearPendingFlush = () => {
    latest.current = { ...latest.current, isCommittable: false };
  };

  const commit = () => {
    clearPendingFlush();
    if (isCommittable) {
      onCommit(normalized);
    }
    setDraftState(null);
  };
  const revert = () => {
    clearPendingFlush();
    setDraftState(null);
  };

  // the ref is written in an effect, never during render, so a discarded render (StrictMode, concurrent) can't leak values into the cleanup — the flush always sees the last committed draft
  useEffect(() => {
    latest.current = { isCommittable, normalized, onCommit, flushOnUnmount };
  });
  useEffect(
    () => () => {
      const current = latest.current;
      if (current.flushOnUnmount && current.isCommittable) {
        current.onCommit(current.normalized);
      }
    },
    [],
  );

  return { draft, setDraft, commit, revert, error: validate ? validate(normalized) : null };
}

// Escape must revert, but element.blur() fires the blur handler synchronously with the pre-revert draft in scope — revert goes through a ref the blur handler checks before committing
export function useCommitDraftBlurHandlers(draft: Pick<CommitDraft, "commit" | "revert">): {
  readonly onBlur: () => void;
  readonly revertAndBlur: (element: { blur(): void }) => void;
} {
  const revertingRef = useRef(false);
  return {
    onBlur: () => {
      if (revertingRef.current) {
        revertingRef.current = false;
        draft.revert();
        return;
      }
      draft.commit();
    },
    revertAndBlur: (element) => {
      revertingRef.current = true;
      element.blur();
    },
  };
}
