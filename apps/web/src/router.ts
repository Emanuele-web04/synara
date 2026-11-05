import { windowQueryNamespace } from "./lib/hosts/controlQueryScope";
import { registerExecutionSwitchGuard } from "./lib/hosts/executionSwitch";
import { recoverWorkspaceEditors, readWorkspaceEditorDrafts } from "./lib/workspaceEditorSession";
import { flushDeferredStorage } from "./lib/storage";
import { createElement } from "react";
import { QueryClient, QueryClientProvider, hashKey } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { watchAccountIdentityChanges } from "./lib/accountReactQuery";
import { routeTree } from "./routeTree.gen";
import { StoreProvider } from "./store";

type RouterHistory = NonNullable<Parameters<typeof createRouter>[0]["history"]>;

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { queryKeyHashFn: (key) => hashKey(windowQueryNamespace(key)) } },
  });
  // Evicts account-scoped caches whenever the signed-in identity changes —
  // including switches this client only observes through a status refetch
  // (an account switch performed by another renderer against the shared
  // server). Lives as long as the QueryClient, so never unsubscribed.
  watchAccountIdentityChanges(queryClient);
  registerExecutionSwitchGuard({
    recover: () => {
      const resume = recoverWorkspaceEditors(queryClient);
      try {
        flushDeferredStorage();
      } catch (error) {
        resume?.();
        throw error;
      }
      return resume;
    },
    drafts: () => readWorkspaceEditorDrafts(queryClient),
  });

  return createRouter({
    routeTree,
    history,
    // Routes are auto-code-split and have no loaders, so intent preloading only
    // fetches the route chunk on link hover/touch — first navigation skips the
    // chunk download/parse wait.
    defaultPreload: "intent",
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StoreProvider, null, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
