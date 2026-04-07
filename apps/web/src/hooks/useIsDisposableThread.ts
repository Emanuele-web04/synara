import { type ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";

export function useIsDisposableThread(threadId: ThreadId | null | undefined): boolean {
  const hasTemporaryThreadMarker = useTemporaryThreadStore((store) =>
    threadId ? store.temporaryThreadIds[threadId] === true : false,
  );
  const hasTemporaryDraftMetadata = useComposerDraftStore((store) =>
    threadId ? store.draftThreadsByThreadId[threadId]?.isTemporary === true : false,
  );
  const seenDisposableThreadIdsRef = useRef<Set<ThreadId>>(new Set());

  useEffect(() => {
    if (!threadId) {
      return;
    }
    // Latch positives to avoid transient UI flicker during draft/server promotion.
    if (hasTemporaryThreadMarker || hasTemporaryDraftMetadata) {
      seenDisposableThreadIdsRef.current.add(threadId);
    }
  }, [threadId, hasTemporaryDraftMetadata, hasTemporaryThreadMarker]);

  if (!threadId) {
    return false;
  }
  return (
    hasTemporaryThreadMarker ||
    hasTemporaryDraftMetadata ||
    seenDisposableThreadIdsRef.current.has(threadId)
  );
}
