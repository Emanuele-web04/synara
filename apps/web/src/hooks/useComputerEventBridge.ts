// FILE: useComputerEventBridge.ts
// Purpose: Route the server's computer.event push into the computer state store and the dock.
// Layer: Web event bridge hook
// Exports: useComputerEventBridge
// Depends on: nativeApi computer.onEvent, computerStateStore
//
// Mirrors useDeviceEventBridge: the computer engine lives in apps/server, so the
// open-pane signal is a WebSocket push and this works in a plain browser tab as
// well as the desktop app.

import type { ComputerOpenPaneRequestedEvent } from "@synara/contracts";
import { useEffect, useEffectEvent } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { useComputerStateStore } from "../computerStateStore";

export function useComputerEventBridge(input: {
  /** Null while the surface cannot route a pane open (e.g. split view). */
  readonly onOpenPaneRequested: ((event: ComputerOpenPaneRequestedEvent) => void) | null;
}): void {
  const { onOpenPaneRequested } = input;
  const handleOpen = useEffectEvent((event: ComputerOpenPaneRequestedEvent) =>
    onOpenPaneRequested?.(event),
  );
  const openEnabled = onOpenPaneRequested !== null;

  useEffect(() => {
    const api = ensureNativeApi();
    if (!api.computer) {
      return;
    }
    // The state half of the subscription runs regardless of whether this surface
    // can open panes: a pane on another thread still needs fresh state, and the
    // store is version-gated so duplicate delivery is harmless.
    const unsubscribe = api.computer.onEvent((event) => {
      const store = useComputerStateStore.getState();
      switch (event.type) {
        case "computer.thread-state":
          store.upsertThreadState(event.state);
          break;
        case "computer.windows-changed":
          store.applyWindowsChanged(event.windows);
          break;
        case "computer.action":
          store.recordAction(event);
          break;
        case "computer.open-pane-requested":
          if (openEnabled) handleOpen(event);
          break;
        case "computer.frame":
          break;
      }
    });
    return unsubscribe;
  }, [openEnabled]);
}
