// FILE: useComputerEventBridge.ts
// Purpose: Capture computer events globally and arm the in-chat preview sessions.
// Layer: Web event bridge hook
// Exports: useComputerEventBridge
// Depends on: nativeApi computer.onEvent, computerStateStore, computerPreviewStore
//
// Mirrors useDeviceEventBridge: the computer engine lives in apps/server, so the
// open-pane signal is a WebSocket push and this works in a plain browser tab as
// well as the desktop app.
//
// `computer.open-pane-requested` arms the owning thread's preview session.
// The in-chat popover is the only Computer surface.

import { useEffect } from "react";

import { computerActionStatusLabel } from "~/components/ComputerPanel.logic";
import {
  changedThreadComputerStates,
  removedThreadComputerStateIds,
} from "~/components/chat/ComputerPreviewPopover.logic";
import { ThreadId } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { useComputerPreviewStore } from "../computerPreviewStore";
import { useComputerStateStore } from "../computerStateStore";

/** Mounted once by EventRouter, including while settings or split view is open. */
export function useComputerEventBridge(): void {
  useEffect(() => {
    const api = ensureNativeApi();
    if (!api.computer) {
      return;
    }
    const unsubscribe = api.computer.onEvent((event) => {
      const store = useComputerStateStore.getState();
      const preview = useComputerPreviewStore.getState();
      switch (event.type) {
        case "computer.thread-state":
          store.upsertThreadState(event.state);
          break;
        case "computer.windows-changed":
          store.applyWindowsChanged(event.windows);
          break;
        case "computer.action": {
          store.recordAction(event);
          const threadId = event.threadId;
          if (threadId) {
            const label = computerActionStatusLabel(
              event,
              store.threadStatesByThreadId[threadId]?.windows,
            );
            if (label !== null) {
              preview.noteThreadActionLabel(threadId, label);
            }
          }
          break;
        }
        case "computer.open-pane-requested":
          // The server sends this once per lease. What honors it is the
          // preview session on the owning thread, armed whether or not that
          // chat is on screen.
          preview.requestPreviewSurface(event.threadId);
          break;
        case "computer.frame":
          break;
      }
    });
    // Thread state also arrives through getThreadState seeds, which never pass
    // the push handler above. Watching the store itself feeds both paths into
    // the same edge detection, and a wholesale cache reset (server restart)
    // ends every session with it.
    const unsubscribeThreadStates = useComputerStateStore.subscribe((state, previous) => {
      const nextStates = state.threadStatesByThreadId;
      if (nextStates === previous.threadStatesByThreadId) {
        return;
      }
      const preview = useComputerPreviewStore.getState();
      if (Object.keys(nextStates).length === 0) {
        if (Object.keys(previous.threadStatesByThreadId).length > 0) {
          preview.clear();
        }
        return;
      }
      for (const threadState of changedThreadComputerStates(
        nextStates,
        previous.threadStatesByThreadId,
      )) {
        preview.noteThreadComputerState(threadState);
      }
      for (const threadId of removedThreadComputerStateIds(
        nextStates,
        previous.threadStatesByThreadId,
      )) {
        preview.removePreviewSession(ThreadId.makeUnsafe(threadId));
      }
    });
    return () => {
      unsubscribe();
      unsubscribeThreadStates();
    };
  }, []);
}
