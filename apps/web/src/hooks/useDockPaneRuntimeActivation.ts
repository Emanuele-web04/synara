// FILE: useDockPaneRuntimeActivation.ts
// Purpose: React lifecycle wrapper for right-dock runtime hydration (preview vs live).
// Layer: Web UI hook
// Depends on: dockPaneActivation pure policy and rightDockStore pane metadata.

import type { ThreadId } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  DOCK_PANE_DEFERRED_HYDRATION_FRAMES,
  dockPaneActivationKey,
  resolveDockPaneRuntimeMode,
  type DockPaneRuntimeMode,
} from "~/lib/dockPaneActivation";
import type { RightDockPane, RightDockPaneKind } from "~/rightDockStore.logic";

export function useDockPaneRuntimeActivation(input: {
  threadId: ThreadId;
  activePane: RightDockPane | null;
}) {
  const immediateHydrationKindRef = useRef<RightDockPaneKind | "any" | null>(null);
  const [hydratedPaneKey, setHydratedPaneKey] = useState<string | null>(null);

  const activePaneKey = useMemo(
    () =>
      input.activePane
        ? dockPaneActivationKey({
            threadId: input.threadId,
            paneId: input.activePane.id,
            kind: input.activePane.kind,
          })
        : null,
    [input.activePane, input.threadId],
  );

  const activePaneRuntimeMode: DockPaneRuntimeMode =
    input.activePane && activePaneKey
      ? resolveDockPaneRuntimeMode({
          kind: input.activePane.kind,
          reason:
            immediateHydrationKindRef.current === "any" ||
            immediateHydrationKindRef.current === input.activePane.kind
              ? "explicit"
              : "restore",
          hydrated: hydratedPaneKey === activePaneKey,
        })
      : "live";

  const requestImmediateHydration = useCallback(
    (kind?: RightDockPaneKind) => {
      immediateHydrationKindRef.current = kind ?? "any";
      if (activePaneKey && (!kind || input.activePane?.kind === kind)) {
        setHydratedPaneKey(activePaneKey);
      }
    },
    [activePaneKey, input.activePane],
  );

  const requestActivePaneLive = useCallback(() => {
    immediateHydrationKindRef.current = input.activePane?.kind ?? "any";
    if (activePaneKey) {
      setHydratedPaneKey(activePaneKey);
    }
  }, [activePaneKey, input.activePane]);

  useLayoutEffect(() => {
    if (!input.activePane || !activePaneKey) {
      immediateHydrationKindRef.current = null;
      setHydratedPaneKey(null);
      return;
    }

    const reason =
      immediateHydrationKindRef.current === "any" ||
      immediateHydrationKindRef.current === input.activePane.kind
        ? "explicit"
        : "restore";
    if (reason === "explicit") {
      immediateHydrationKindRef.current = null;
    }

    const nextRuntimeMode = resolveDockPaneRuntimeMode({
      kind: input.activePane.kind,
      reason,
      hydrated: hydratedPaneKey === activePaneKey,
    });

    if (nextRuntimeMode === "live") {
      setHydratedPaneKey(activePaneKey);
      return;
    }

    setHydratedPaneKey((current) => (current === activePaneKey ? current : null));
    let cancelled = false;
    let frameId: number | null = null;
    let framesRemaining = DOCK_PANE_DEFERRED_HYDRATION_FRAMES;

    const tick = () => {
      framesRemaining -= 1;
      if (cancelled) {
        return;
      }
      if (framesRemaining <= 0) {
        setHydratedPaneKey(activePaneKey);
        return;
      }
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [activePaneKey, hydratedPaneKey, input.activePane]);

  return {
    activePaneRuntimeMode,
    requestActivePaneLive,
    requestImmediateHydration,
  };
}
