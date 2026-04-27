// FILE: chatRouteRestore.ts
// Purpose: Validates saved chat routes before restoring them from startup or sidebar navigation.
// Layer: Route helper
// Exports: last-thread route type plus restore resolver shared by Sidebar and chat index.

export type LastThreadRoute = {
  threadId: string;
  splitViewId?: string | undefined;
};

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
