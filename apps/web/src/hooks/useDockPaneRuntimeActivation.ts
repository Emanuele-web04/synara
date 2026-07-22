// FILE: useDockPaneRuntimeActivation.ts
// Purpose: React lifecycle wrapper for right-dock runtime hydration (preview vs live).
// Layer: Web UI hook
// Depends on: dockPaneActivation pure policy and rightDockStore pane metadata.

import type { ThreadId } from "@synara/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  dockPaneActivationKey,
  resolveDockPaneRuntimeMode,
  scheduleDeferredDockPaneHydration,
  type DeferredDockPaneHydrationScheduler,
  type DockPaneRuntimeMode,
} from "~/lib/dockPaneActivation";
import type { RightDockPane, RightDockPaneKind } from "~/rightDockStore.logic";

const browserDockPaneHydrationScheduler: DeferredDockPaneHydrationScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timerId) => window.clearTimeout(timerId),
};

export function useDockPaneRuntimeActivation(input: {
  threadId: ThreadId;
  activePane: RightDockPane | null;
}) {
  const immediateHydrationKindRef = useRef<RightDockPaneKind | "any" | null>(null);
  const [hydratedPaneKey, setHydratedPaneKey] = useState<string | null>(null);
  const activePaneId = input.activePane?.id ?? null;
  const activePaneKind = input.activePane?.kind ?? null;

  const activePaneKey = useMemo(
    () =>
      activePaneId !== null && activePaneKind !== null
        ? dockPaneActivationKey({
            threadId: input.threadId,
            paneId: activePaneId,
            kind: activePaneKind,
          })
        : null,
    [activePaneId, activePaneKind, input.threadId],
  );

  const activePaneRuntimeMode: DockPaneRuntimeMode =
    activePaneKind !== null && activePaneKey !== null
      ? resolveDockPaneRuntimeMode({
          kind: activePaneKind,
          reason:
            immediateHydrationKindRef.current === "any" ||
            immediateHydrationKindRef.current === activePaneKind
              ? "explicit"
              : "restore",
          hydrated: hydratedPaneKey === activePaneKey,
        })
      : "live";

  // The request callbacks read the committed active pane through a ref so their
  // identity stays stable across pane switches. Handlers built on top of them
  // (and the workspace file opener context value) would otherwise be recreated
  // on every dock tab change, re-rendering every context subscriber in the
  // chat transcript. Event handlers always fire after commit, so the ref is
  // current by the time either callback runs.
  const activePaneRef = useRef<{ key: string | null; kind: RightDockPaneKind | null }>({
    key: null,
    kind: null,
  });
  useLayoutEffect(() => {
    activePaneRef.current = {
      key: activePaneKey,
      kind: activePaneKind,
    };
  }, [activePaneKey, activePaneKind]);

  const requestImmediateHydration = useCallback((kind?: RightDockPaneKind) => {
    immediateHydrationKindRef.current = kind ?? "any";
    const active = activePaneRef.current;
    if (active.key && (!kind || active.kind === kind)) {
      setHydratedPaneKey(active.key);
    }
  }, []);

  const requestActivePaneLive = useCallback(() => {
    const active = activePaneRef.current;
    immediateHydrationKindRef.current = active.kind ?? "any";
    if (active.key) {
      setHydratedPaneKey(active.key);
    }
  }, []);

  useLayoutEffect(() => {
    if (activePaneKind === null || activePaneKey === null) {
      immediateHydrationKindRef.current = null;
      setHydratedPaneKey(null);
      return;
    }

    const reason =
      immediateHydrationKindRef.current === "any" ||
      immediateHydrationKindRef.current === activePaneKind
        ? "explicit"
        : "restore";
    if (reason === "explicit") {
      immediateHydrationKindRef.current = null;
    }

    const nextRuntimeMode = resolveDockPaneRuntimeMode({
      kind: activePaneKind,
      reason,
      hydrated: hydratedPaneKey === activePaneKey,
    });

    if (nextRuntimeMode === "live") {
      setHydratedPaneKey(activePaneKey);
      return;
    }

    setHydratedPaneKey((current) => (current === activePaneKey ? current : null));
    return scheduleDeferredDockPaneHydration({
      onHydrate: () => setHydratedPaneKey(activePaneKey),
      scheduler: browserDockPaneHydrationScheduler,
    });
  }, [activePaneKey, activePaneKind, hydratedPaneKey]);

  return {
    activePaneRuntimeMode,
    requestActivePaneLive,
    requestImmediateHydration,
  };
}
