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

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { computerActionStatusLabel } from "~/components/ComputerPanel.logic";
import {
  changedThreadComputerStates,
  removedThreadComputerStateIds,
} from "~/components/chat/ComputerPreviewPopover.logic";
import { type DesktopBridge, ThreadId } from "@synara/contracts";
import { readLocalComputerPermissionBridge } from "~/lib/computerProvisioning";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { useComputerPreviewStore } from "../computerPreviewStore";
import { useComputerStateStore } from "../computerStateStore";

/** A native grant can land while System Settings owns focus and query polling is paused. */
export function subscribeComputerPermissionStatus(
  queryClient: QueryClient,
  bridge: Pick<DesktopBridge["appSnap"], "onState"> | null = readLocalComputerPermissionBridge(),
): () => void {
  if (!bridge) return () => undefined;
  let previous: string | undefined;
  return bridge.onState((state) => {
    // AppSnap-only snapshots do not establish Accessibility and must not turn
    // an unused Computer feature on. Only refresh an already requested status.
    if (
      !state.supported ||
      state.platform !== "macos" ||
      state.accessibilityPermission === undefined
    )
      return;
    const grants = [
      state.accessibilityPermission,
      state.inputMonitoringPermission,
      state.screenRecordingPermission,
    ].join(",");
    if (grants === previous) return;
    previous = grants;
    if (queryClient.getQueryState(serverQueryKeys.computerStatus())) {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.computerStatus() });
    }
  });
}

/** Mounted once by EventRouter, including while settings or split view is open. */
export function useComputerEventBridge(): void {
  const queryClient = useQueryClient();
  useEffect(() => subscribeComputerPermissionStatus(queryClient), [queryClient]);
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
        case "computer.input-stopped":
          // Host-wide: update the latch every surface reads, and re-pull the
          // status the settings panel polls so its indicator flips at the
          // press rather than on the next interval.
          store.setInputStopped(event.stopped);
          void queryClient.invalidateQueries({
            queryKey: serverQueryKeys.computerStatus(),
          });
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
  }, [queryClient]);
}
