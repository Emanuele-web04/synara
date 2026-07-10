// FILE: useDockPaneRuntimeActivation.ts
// Purpose: React lifecycle wrapper for right-dock runtime hydration (preview vs live).
// Layer: Web UI hook
// Depends on: dockPaneActivation pure policy and rightDockStore pane metadata.

import type { ThreadId } from "@synara/contracts";
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
      kind: input.activePane?.kind ?? null,
    };
  }, [activePaneKey, input.activePane]);

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
