// FILE: useAppSnapWindows.ts
// Purpose: Subscribes to AppSnap desktop state and lists capturable windows while a picker is open.
// Layer: Chat composer state
// Depends on: the desktop AppSnap bridge and the shared capture attach helper.

import type { DesktopAppSnapState, DesktopAppSnapWindowEntry, ThreadId } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { attachAppSnapCapture } from "~/appSnapAttach";
import { toastManager } from "../ui/toast";

const APP_SNAP_WINDOW_LIST_ATTEMPT_LIMIT = 2;

export function appSnapUnavailableMessage(state: DesktopAppSnapState): string {
  if (!state.enabled || state.status === "disabled") return "Enable AppSnap in Settings";
  if (state.status === "permission-required") return "Finish AppSnap permissions in Settings";
  if (state.status === "starting") return "AppSnap is starting…";
  return state.message?.trim() || "AppSnap is unavailable.";
}

export type AppSnapWindowPicker = {
  /** True when this build can capture windows for the given thread at all. */
  available: boolean;
  /** Null while the list is still loading. */
  windows: DesktopAppSnapWindowEntry[] | null;
  /** Set when listing failed or AppSnap is not ready — render instead of the list. */
  unavailableMessage: string | null;
  busy: boolean;
  captureWindow: (windowId: number) => void;
};

/**
 * Owns the AppSnap listing lifecycle for a picker that is open/closed by the caller.
 * Listing is bounded: a ready state lists once, and a failed list is retried at most
 * once on a later ready state so a broken bridge cannot spin.
 */
export function useAppSnapWindows(input: {
  open: boolean;
  threadId?: ThreadId;
}): AppSnapWindowPicker {
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const [windows, setWindows] = useState<DesktopAppSnapWindowEntry[] | null>(null);
  const [state, setState] = useState<DesktopAppSnapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bridge = window.desktopBridge?.appSnap;
  const threadId = input.threadId;
  const available = Boolean(threadId && bridge);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!input.open || !bridge) return;

    setWindows(null);
    setError(null);
    setState(null);

    let disposed = false;
    let listedForReadyState = false;
    let windowListAttempts = 0;

    const applyState = (nextState: DesktopAppSnapState) => {
      if (disposed) return;
      setState(nextState);

      if (nextState.status !== "ready") {
        listedForReadyState = false;
        windowListAttempts = 0;
        requestIdRef.current += 1;
        setError(null);
        setWindows([]);
        return;
      }
      if (listedForReadyState || windowListAttempts >= APP_SNAP_WINDOW_LIST_ATTEMPT_LIMIT) {
        return;
      }
      listedForReadyState = true;
      windowListAttempts += 1;

      const requestId = ++requestIdRef.current;
      setError(null);
      setWindows(null);
      void bridge
        .listWindows()
        .then((listed) => {
          if (!disposed && requestIdRef.current === requestId) {
            setWindows(listed);
          }
        })
        .catch((listError) => {
          if (!disposed && requestIdRef.current === requestId) {
            listedForReadyState = false;
            setError(listError instanceof Error ? listError.message : "Could not list windows.");
          }
        });
    };

    const unsubscribe = bridge.onState(applyState);
    const requestId = ++requestIdRef.current;
    void bridge
      .getState()
      .then((initialState) => {
        if (!disposed && requestIdRef.current === requestId) applyState(initialState);
      })
      .catch((stateError) => {
        if (!disposed && requestIdRef.current === requestId) {
          setError(stateError instanceof Error ? stateError.message : "Could not list windows.");
        }
      });

    return () => {
      disposed = true;
      requestIdRef.current += 1;
      unsubscribe();
    };
  }, [bridge, input.open]);

  const captureWindow = (windowId: number) => {
    const activeBridge = window.desktopBridge?.appSnap;
    if (!activeBridge || !threadId || busy) return;
    setBusy(true);
    void activeBridge
      .captureWindow({ windowId })
      .then(async (capture) => {
        await attachAppSnapCapture(threadId, capture, () =>
          activeBridge.acknowledgeCapture(capture.id),
        );
      })
      .catch((captureError) => {
        toastManager.add({
          type: "error",
          title: "AppSnap failed",
          description:
            captureError instanceof Error ? captureError.message : "Could not capture the window.",
          data: { allowCrossThreadVisibility: true },
        });
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const unavailableMessage =
    error ?? (state && state.status !== "ready" ? appSnapUnavailableMessage(state) : null);

  return { available, windows, unavailableMessage, busy, captureWindow };
}
