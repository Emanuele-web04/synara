import { createElement, useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { applyReviewUpdatedPayload } from "./lib/reviewReactQuery";
import { ensureNativeApi } from "./nativeApi";
import { routeTree } from "./routeTree.gen";
import { StoreProvider } from "./store";

type RouterHistory = NonNullable<Parameters<typeof createRouter>[0]["history"]>;

function ReviewUpdateProvider({
  children,
  queryClient,
}: {
  readonly children?: ReactNode;
  readonly queryClient: QueryClient;
}) {
  useEffect(
    () =>
      ensureNativeApi().review.onUpdated((payload) =>
        applyReviewUpdatedPayload(queryClient, payload),
      ),
    [queryClient],
  );
  return createElement(StoreProvider, null, children);
}

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient();

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
        createElement(ReviewUpdateProvider, { queryClient }, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
