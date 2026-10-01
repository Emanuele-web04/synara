import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "~/types";

const fixture = vi.hoisted(() => ({
  getRecap: vi.fn(),
  navigate: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  INBOX_ON: false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({ stats: { getRecap: fixture.getRecap } }),
}));
vi.mock("~/hooks/useActivityThreads", () => ({ useActivityThreads: fixture.activity }));

import InboxView from "./InboxView";
import { Route as inboxRoute } from "~/routes/_chat.inbox";

it("redirects a Stable Inbox deep link before mounting its route component", async () => {
  const mounted = vi.fn();
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> });
  const inbox = createRoute({
    getParentRoute: () => root,
    path: "/inbox",
    // Reuse the production guard in this small router, without its app layout context.
    beforeLoad: (inboxRoute as AnyRoute).options.beforeLoad,
    component: () => {
      mounted();
      return <p>Inbox mounted</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([home, inbox]),
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  try {
    await expect.poll(() => router.state.status).toBe("idle");
    expect(router.state.location.pathname).toBe("/");
    expect(mounted).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("does not manually refetch a disabled recap when a completion arrives before redirect finishes", async () => {
  fixture.getRecap.mockReset();
  fixture.navigate.mockReset();
  fixture.activity.mockReturnValue({ visibleNonGroupThreads: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => (
    <QueryClientProvider client={client}>
      <InboxView />
    </QueryClientProvider>
  );
  const view = await render(content());
  try {
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
    // Keep the unavailable view mounted, as while its client redirect is pending.
    fixture.activity.mockReturnValue({
      visibleNonGroupThreads: [
        {
          latestTurn: { completedAt: "2026-09-30T12:00:00.000Z" },
          lastVisitedAt: "2026-09-30T12:00:00.000Z",
        } as SidebarThreadSummary,
      ],
    });
    await view.rerender(content());
    // The completion effect schedules a zero-delay manual refetch on first update.
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(fixture.getRecap).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    client.clear();
  }
});
