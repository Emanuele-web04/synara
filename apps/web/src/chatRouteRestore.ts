// FILE: chatRouteRestore.ts
// Purpose: Validates saved chat routes before restoring them from startup or sidebar navigation.
// Layer: Route helper
// Exports: last-thread route resolver plus empty-startup fallback policy helpers.

export type LastThreadRoute = {
  threadId: string;
  splitViewId?: string | undefined;
};

export type EmptyRouteRestoreRecoveryState = "idle" | "pending" | "done";

export const EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS = 1_800;

export function collectKnownThreadIds(input: {
  threadIds: readonly string[];
  sidebarThreadSummaryIds: readonly string[];
}): Set<string> {
  return new Set([...input.threadIds, ...input.sidebarThreadSummaryIds]);
}

export function resolveRestorableThreadRoute(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadIds: ReadonlySet<string>;
  availableSplitViewIds?: ReadonlySet<string>;
}): LastThreadRoute | null {
  const { lastThreadRoute, availableThreadIds, availableSplitViewIds } = input;
  if (!lastThreadRoute) {
    return null;
  }

  if (!availableThreadIds.has(lastThreadRoute.threadId)) {
    return null;
  }

  if (
    lastThreadRoute.splitViewId &&
    availableSplitViewIds &&
    !availableSplitViewIds.has(lastThreadRoute.splitViewId)
  ) {
    return { threadId: lastThreadRoute.threadId };
  }

  return lastThreadRoute;
}

export function resolveRestorableThreadRouteWithFallback(input: {
  lastThreadRoute: LastThreadRoute | null;
  fallbackRoutes: readonly LastThreadRoute[];
  availableThreadIds: ReadonlySet<string>;
  availableSplitViewIds?: ReadonlySet<string>;
}): LastThreadRoute | null {
  const rememberedRoute = resolveRestorableThreadRoute(input);
  if (rememberedRoute || input.lastThreadRoute) {
    return rememberedRoute;
  }

  for (const fallbackRoute of input.fallbackRoutes) {
    const restorableFallback = resolveRestorableThreadRoute({
      lastThreadRoute: fallbackRoute,
      availableThreadIds: input.availableThreadIds,
      ...(input.availableSplitViewIds
        ? { availableSplitViewIds: input.availableSplitViewIds }
        : {}),
    });
    if (restorableFallback) {
      return restorableFallback;
    }
  }
  return null;
}

// Route fallback guards separate a stale URL from a temporarily empty startup snapshot.
export function shouldStartRememberedRouteRecovery(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadCount: number;
  recoveryState: EmptyRouteRestoreRecoveryState;
}): boolean {
  return Boolean(
    input.lastThreadRoute && input.availableThreadCount === 0 && input.recoveryState === "idle",
  );
}

export function shouldHoldRememberedRouteFallback(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadCount: number;
  recoveryState: EmptyRouteRestoreRecoveryState;
}): boolean {
  return Boolean(
    input.lastThreadRoute && input.availableThreadCount === 0 && input.recoveryState !== "done",
  );
}

export function shouldStartUnresolvedRememberedRouteRecovery(input: {
  enabled: boolean;
  lastThreadRoute: LastThreadRoute | null;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeRestorable: boolean;
}): boolean {
  return Boolean(
    input.enabled &&
    input.lastThreadRoute &&
    !input.routeRestorable &&
    input.recoveryState === "idle",
  );
}

export function shouldHoldUnresolvedRememberedRouteFallback(input: {
  enabled: boolean;
  lastThreadRoute: LastThreadRoute | null;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeRestorable: boolean;
}): boolean {
  return Boolean(
    input.enabled &&
    input.lastThreadRoute &&
    !input.routeRestorable &&
    input.recoveryState === "pending",
  );
}

export function shouldStartMissingThreadRouteRecovery(input: {
  hasKnownServerThreads: boolean;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeThreadExists: boolean;
}): boolean {
  return !input.routeThreadExists && !input.hasKnownServerThreads && input.recoveryState === "idle";
}

export function shouldHoldMissingThreadRouteFallback(input: {
  hasKnownServerThreads: boolean;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeThreadExists: boolean;
}): boolean {
  return !input.routeThreadExists && !input.hasKnownServerThreads && input.recoveryState !== "done";
}
