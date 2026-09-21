// the browser pane gets open requests over desktop IPC; the device engine lives in apps/server, so the equivalent signal is a WebSocket push — works in a plain browser too

import type { DeviceOpenPaneRequestedEvent } from "@synara/contracts";
import { useEffect, useEffectEvent } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { useDeviceStateStore } from "../deviceStateStore";

export function useDeviceEventBridge(): void {
  useEffect(() => {
    const unsubscribe = ensureNativeApi().device.onEvent((event) => {
      const store = useDeviceStateStore.getState();
      if (event.type === "device.thread-state") {
        store.upsertThreadState(event.state);
      } else {
        // the server sends this once per thread/device — retain it until a surface can honor it, even if automatic opening is off
        store.queueOpenRequest(event);
      }
    });
    return unsubscribe;
  }, []);
}

export function useDevicePaneOpenRequests(input: {
  readonly onOpenPaneRequested: ((event: DeviceOpenPaneRequestedEvent) => void) | null;
}): void {
  const pendingOpenRequests = useDeviceStateStore((store) => store.pendingOpenRequests);
  const openEnabled = input.onOpenPaneRequested !== null;
  const deliverPendingRequests = useEffectEvent(() => {
    const onOpen = input.onOpenPaneRequested;
    if (!onOpen) return;
    // Consume before delivery so remounting or closing a pane never replays it.
    for (const event of useDeviceStateStore.getState().takeOpenRequests()) onOpen(event);
  });

  useEffect(() => {
    if (openEnabled) deliverPendingRequests();
  }, [openEnabled, pendingOpenRequests]);
}
