// FILE: RestoreOrCreateChatRoute.tsx
// Purpose: Shared cold-start machinery for chat index routes — guards against briefly-empty
//          bootstrap snapshots, then defers to a caller-supplied resolver to pick the thread
//          route to restore, falling back to creating a fresh draft. Used by the home-chat index
//          route and the Studio index route so both get identical empty-snapshot recovery.
// Layer: Routing
// Depends on: sidebar UI persistence plus caller-supplied restore/fresh-chat policy.

import { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { SplashScreen } from "./SplashScreen";
import {
  collectKnownThreadIds,
  type EmptyRouteRestoreRecoveryState,
  type LastThreadRoute,
  shouldHoldRememberedRouteFallback,
  shouldHoldUnresolvedRememberedRouteFallback,
  shouldStartRememberedRouteRecovery,
  shouldStartUnresolvedRememberedRouteRecovery,
} from "../chatRouteRestore";
import { readSidebarUiState } from "./Sidebar.uiState";
import {
  refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay,
} from "../chatRouteRecovery";
import type { StartContainerChatResult } from "../lib/startContainerChat";
import { readNativeApi } from "../nativeApi";
import { useSplitViewStore } from "../splitViewStore";
import { EMPTY_THREAD_IDS, useStore } from "../store";

export type RestoreRouteResolverInput = {
  // Split views currently known to the client. Callers that support split-view restore should
  // filter their resolved route's `splitViewId` against this set.
  readonly availableSplitViewIds: ReadonlySet<string>;
};

// Resolves which thread route (if any) this surface should restore to. Returning `null` defers
// to `createFreshChat` (e.g. because there is a draft to reopen instead of an existing thread).
export type RestoreRouteResolver = (input: RestoreRouteResolverInput) => LastThreadRoute | null;

export function RestoreOrCreateChatRoute({
  resolveRestoreRoute,
  createFreshChat,
  fallbackRestoreRoute,
  shouldRecoverUnresolvedRememberedRoute,
}: {
  // Surface-specific policy for picking the thread route to restore (e.g. the last-visited route
  // for home chats, the latest Studio thread or draft for Studio). The remembered-route recovery
  // below still keys off the total thread count, which is shared across surfaces.
  readonly resolveRestoreRoute: RestoreRouteResolver;
  readonly createFreshChat: () => Promise<StartContainerChatResult>;
  // Persisted MRU routes hydrate independently from the server thread shell. When the dedicated
  // sidebar route is absent, expose the leading MRU candidate so startup can refresh the shell
  // before deciding that there is nothing to restore.
  readonly fallbackRestoreRoute?: LastThreadRoute | null | undefined;
  // Some surfaces receive their workspace conversation summaries after the legacy thread shell.
  // They can opt into one authoritative refresh before treating a missing remembered route as
  // stale. The callback keeps deliberate cross-surface routes (for example Studio from "/") fast.
  readonly shouldRecoverUnresolvedRememberedRoute?:
    | ((lastThreadRoute: LastThreadRoute) => boolean)
    | undefined;
}) {
  const navigate = useNavigate();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const knownThreadCount = useMemo(
    () =>
      collectKnownThreadIds({
        threadIds,
        sidebarThreadSummaryIds: Object.keys(sidebarThreadSummaryById),
      }).size,
    [sidebarThreadSummaryById, threadIds],
  );
  const splitViewsHydrated = useSplitViewStore((state) => state.hasHydrated);
  const splitViewsById = useSplitViewStore((state) => state.splitViewsById);
  const splitViewIds = Object.keys(splitViewsById).filter(
    (splitViewId) => splitViewsById[splitViewId],
  );
  const [attempt, setAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyRestoreRecoveryState, setEmptyRestoreRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const [unresolvedRestoreRecoveryState, setUnresolvedRestoreRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const mountedRef = useRef(true);
  const emptyRestoreRecoveryRunRef = useRef(0);
  const unresolvedRestoreRecoveryRunRef = useRef(0);
  // One fresh-chat creation at a time per mount: a dep change mid-create re-runs the effect,
  // and without this guard the superseded run and the new run could both mint a draft.
  const createFreshChatInFlightRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!(knownThreadCount > 0 && emptyRestoreRecoveryState !== "idle")) {
      return;
    }
    // Timeout-0 keeps the state write asynchronous (compiler-eligible); the
    // recovery machine only gates async restore flows.
    const timeoutId = window.setTimeout(() => {
      emptyRestoreRecoveryRunRef.current += 1;
      setEmptyRestoreRecoveryState("idle");
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [emptyRestoreRecoveryState, knownThreadCount]);

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
    }

    let cancelled = false;

    void (async () => {
      // Yield one microtask so every state write below happens asynchronously
      // (no wasted pre-paint render; keeps the component compiler-eligible).
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      setErrorMessage(null);
      const lastThreadRoute = readSidebarUiState().lastThreadRoute;
      if (
        shouldStartRememberedRouteRecovery({
          lastThreadRoute,
          availableThreadCount: knownThreadCount,
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
          availableThreadCount: knownThreadCount,
          recoveryState: emptyRestoreRecoveryState,
        })
      ) {
        return;
      }

      const restorableRoute = resolveRestoreRoute({
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

      const unresolvedRestoreCandidate = lastThreadRoute ?? fallbackRestoreRoute ?? null;
      const unresolvedRecoveryEnabled = Boolean(
        unresolvedRestoreCandidate &&
        shouldRecoverUnresolvedRememberedRoute?.(unresolvedRestoreCandidate),
      );
      if (
        shouldStartUnresolvedRememberedRouteRecovery({
          enabled: unresolvedRecoveryEnabled,
          lastThreadRoute: unresolvedRestoreCandidate,
          recoveryState: unresolvedRestoreRecoveryState,
          routeRestorable: false,
        })
      ) {
        const recoveryRun = (unresolvedRestoreRecoveryRunRef.current += 1);
        setUnresolvedRestoreRecoveryState("pending");
        await Promise.all([
          refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(() => false),
          waitForEmptyRouteRestoreFallbackDelay(),
        ]);
        if (mountedRef.current && unresolvedRestoreRecoveryRunRef.current === recoveryRun) {
          setUnresolvedRestoreRecoveryState("done");
        }
        return;
      }

      if (
        shouldHoldUnresolvedRememberedRouteFallback({
          enabled: unresolvedRecoveryEnabled,
          lastThreadRoute: unresolvedRestoreCandidate,
          recoveryState: unresolvedRestoreRecoveryState,
          routeRestorable: false,
        })
      ) {
        return;
      }

      if (cancelled || createFreshChatInFlightRef.current) {
        return;
      }
      createFreshChatInFlightRef.current = true;
      // .finally instead of try/finally: React Compiler does not yet support
      // try/finally and would skip optimizing this whole component.
      const result: StartContainerChatResult = await createFreshChat().finally(() => {
        createFreshChatInFlightRef.current = false;
      });
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
    createFreshChat,
    emptyRestoreRecoveryState,
    fallbackRestoreRoute,
    navigate,
    resolveRestoreRoute,
    shouldRecoverUnresolvedRememberedRoute,
    splitViewIds,
    splitViewsHydrated,
    knownThreadCount,
    threadsHydrated,
    unresolvedRestoreRecoveryState,
  ]);

  return (
    <SplashScreen
      errorMessage={errorMessage}
      onRetry={errorMessage ? () => setAttempt((value) => value + 1) : null}
    />
  );
}
