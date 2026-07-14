// FILE: useTemporaryThreadLifecycle.ts
// Purpose: Deletes temporary threads when focus leaves them.
// Layer: Web route lifecycle hook
// Exports: useTemporaryThreadLifecycle

import type { ThreadId } from "@synara/contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { reconcileDeletedThreadFromClient } from "../lib/deletedThreadClientReconciliation";
import { resolveTemporaryThreadIdToDelete } from "../lib/temporaryThread";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { getThreadFromState } from "../threadDerivation";

export function useTemporaryThreadLifecycle(activeThreadId: ThreadId | null): void {
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const initialDraftIsTemporary = useComposerDraftStore(
    (store) =>
      activeThreadId !== null && store.draftThreadsByThreadId[activeThreadId]?.isTemporary === true,
  );
  const previousThreadStateRef = useRef<{
    threadId: ThreadId | null;
    wasTemporary: boolean;
  }>({
    threadId: activeThreadId,
    wasTemporary:
      (activeThreadId ? temporaryThreadIds[activeThreadId] === true : false) ||
      initialDraftIsTemporary,
  });
  const disposingThreadIdsRef = useRef<Set<ThreadId>>(new Set());

  useEffect(() => {
    const previousThreadState = previousThreadStateRef.current;
    const draftThreadsByThreadId = useComposerDraftStore.getState().draftThreadsByThreadId;
    previousThreadStateRef.current = {
      threadId: activeThreadId,
      wasTemporary: activeThreadId
        ? temporaryThreadIds[activeThreadId] === true ||
          draftThreadsByThreadId[activeThreadId]?.isTemporary === true
        : false,
    };

    const temporaryThreadId = resolveTemporaryThreadIdToDelete({
      previousThreadId: previousThreadState.threadId,
      nextThreadId: activeThreadId,
      previousThreadWasTemporary: previousThreadState.wasTemporary,
      draftThreadsByThreadId,
    });
    if (!temporaryThreadId || disposingThreadIdsRef.current.has(temporaryThreadId)) {
      return;
    }

    disposingThreadIdsRef.current.add(temporaryThreadId);
    void (async () => {
      try {
        const api = readNativeApi();
        const storeState = useStore.getState();
        const serverThread = getThreadFromState(storeState, temporaryThreadId) ?? null;

        if (api) {
          if (serverThread?.session && serverThread.session.status !== "closed") {
            await api.orchestration
              .dispatchCommand({
                type: "thread.session.stop",
                commandId: newCommandId(),
                threadId: temporaryThreadId,
                createdAt: new Date().toISOString(),
              })
              .catch(() => undefined);
          }

          await api.terminal
            .close({ threadId: temporaryThreadId, deleteHistory: true })
            .catch(() => undefined);

          if (serverThread) {
            const deletedOnServer = await api.orchestration
              .dispatchCommand({
                type: "thread.delete",
                commandId: newCommandId(),
                threadId: temporaryThreadId,
              })
              .then(() => true)
              .catch(() => false);
            if (deletedOnServer) {
              void reconcileDeletedThreadFromClient({
                threadId: temporaryThreadId,
                removeDeletedThreadFromClientState:
                  useStore.getState().removeDeletedThreadFromClientState,
              });
            }
          }
        }

        clearDraftThread(temporaryThreadId);
        clearTerminalState(temporaryThreadId);
        removeThreadFromSplitViews(temporaryThreadId);
        clearTemporaryThread(temporaryThreadId);
      } finally {
        disposingThreadIdsRef.current.delete(temporaryThreadId);
      }
    })();
  }, [
    activeThreadId,
    clearDraftThread,
    clearTerminalState,
    clearTemporaryThread,
    removeThreadFromSplitViews,
    temporaryThreadIds,
  ]);
}
