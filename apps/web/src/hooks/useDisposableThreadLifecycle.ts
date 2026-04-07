import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveDisposableThreadIdToDispose } from "../lib/disposableThread";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

export function useDisposableThreadLifecycle(activeThreadId: ThreadId | null): void {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const initialDraftThread =
    activeThreadId !== null
      ? useComposerDraftStore.getState().draftThreadsByThreadId[activeThreadId]
      : undefined;
  const previousThreadStateRef = useRef<{
    threadId: ThreadId | null;
    wasTemporary: boolean;
  }>({
    threadId: activeThreadId,
    wasTemporary:
      (activeThreadId ? temporaryThreadIds[activeThreadId] === true : false) ||
      initialDraftThread?.isTemporary === true,
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

    const disposableThreadId = resolveDisposableThreadIdToDispose({
      previousThreadId: previousThreadState.threadId,
      nextThreadId: activeThreadId,
      previousThreadWasTemporary: previousThreadState.wasTemporary,
      draftThreadsByThreadId,
    });
    if (!disposableThreadId || disposingThreadIdsRef.current.has(disposableThreadId)) {
      return;
    }

    disposingThreadIdsRef.current.add(disposableThreadId);
    void (async () => {
      try {
        const api = readNativeApi();
        const serverThread =
          useStore.getState().threads.find((thread) => thread.id === disposableThreadId) ?? null;

        if (api) {
          if (serverThread?.session && serverThread.session.status !== "closed") {
            await api.orchestration
              .dispatchCommand({
                type: "thread.session.stop",
                commandId: newCommandId(),
                threadId: disposableThreadId,
                createdAt: new Date().toISOString(),
              })
              .catch(() => undefined);
          }

          await api.terminal
            .close({ threadId: disposableThreadId, deleteHistory: true })
            .catch(() => undefined);

          if (serverThread) {
            await api.orchestration
              .dispatchCommand({
                type: "thread.delete",
                commandId: newCommandId(),
                threadId: disposableThreadId,
              })
              .catch(() => undefined);
            const snapshot = await api.orchestration.getSnapshot().catch(() => null);
            if (snapshot) {
              syncServerReadModel(snapshot);
            }
          }
        }

        clearDraftThread(disposableThreadId);
        clearTerminalState(disposableThreadId);
        removeThreadFromSplitViews(disposableThreadId);
        clearTemporaryThread(disposableThreadId);
      } finally {
        disposingThreadIdsRef.current.delete(disposableThreadId);
      }
    })();
  }, [
    activeThreadId,
    clearDraftThread,
    clearTerminalState,
    clearTemporaryThread,
    removeThreadFromSplitViews,
    syncServerReadModel,
    temporaryThreadIds,
  ]);
}
