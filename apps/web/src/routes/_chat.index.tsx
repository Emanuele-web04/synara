// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
// Layer: Routing
// Depends on: sidebar UI persistence plus shared new-chat handler for the empty-state fallback.

import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { SplashScreen } from "../components/SplashScreen";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import {
  type EmptyRouteRestoreRecoveryState,
  resolveRestorableThreadRoute,
  shouldHoldRememberedRouteFallback,
  shouldStartRememberedRouteRecovery,
} from "../chatRouteRestore";
import {
  refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay,
} from "../chatRouteRecovery";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { readNativeApi } from "../nativeApi";
import { useSplitViewStore } from "../splitViewStore";
import { EMPTY_THREAD_IDS, useStore } from "../store";

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const splitViewsHydrated = useSplitViewStore((state) => state.hasHydrated);
  const splitViewsById = useSplitViewStore((state) => state.splitViewsById);
  const splitViewIds = useMemo(
    () => Object.keys(splitViewsById).filter((splitViewId) => splitViewsById[splitViewId]),
    [splitViewsById],
  );
  const [attempt, setAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyRestoreRecoveryState, setEmptyRestoreRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const mountedRef = useRef(true);
  const emptyRestoreRecoveryRunRef = useRef(0);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (threadIds.length > 0 && emptyRestoreRecoveryState !== "idle") {
      emptyRestoreRecoveryRunRef.current += 1;
      setEmptyRestoreRecoveryState("idle");
    }
  }, [emptyRestoreRecoveryState, threadIds.length]);

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
    }

    let cancelled = false;
    setErrorMessage(null);

    void (async () => {
      const lastThreadRoute = readSidebarUiState().lastThreadRoute;
      if (
        shouldStartRememberedRouteRecovery({
          lastThreadRoute,
          availableThreadCount: threadIds.length,
          recoveryState: emptyRestoreRecoveryState,
        })
      ) {
        const recoveryRun = (emptyRestoreRecoveryRunRef.current += 1);
        setEmptyRestoreRecoveryState("pending");
        await Promise.all([
          refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(() => false),
          waitForEmptyRouteRestoreFallbackDelay(),
        ]);
        if (mountedRef.current && emptyRestoreRecoveryRunRef.current === recoveryRun) {
          setEmptyRestoreRecoveryState("done");
        }
        return;
      }

      if (
        shouldHoldRememberedRouteFallback({
          lastThreadRoute,
          availableThreadCount: threadIds.length,
          recoveryState: emptyRestoreRecoveryState,
        })
      ) {
        return;
      }

      const restorableRoute = resolveRestorableThreadRoute({
        lastThreadRoute,
        availableThreadIds: new Set(threadIds),
        availableSplitViewIds: new Set(splitViewIds),
      });
      if (restorableRoute) {
        if (cancelled) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(restorableRoute.threadId) },
          replace: true,
          search: () => ({
            splitViewId: restorableRoute.splitViewId,
          }),
        });
        return;
      }

      const result = await handleNewChat({ fresh: true });
      if (cancelled || result.ok) {
        return;
      }
      setErrorMessage(result.error);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    emptyRestoreRecoveryState,
    handleNewChat,
    navigate,
    splitViewIds,
    splitViewsHydrated,
    threadIds,
    threadsHydrated,
  ]);

  return (
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
