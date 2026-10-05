import { isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
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
  listTodos: vi.fn(),
}));
vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  INBOX_ON: isBetaFeatureEnabled("inbox", "production"),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({
    stats: { getRecap: fixture.getRecap },
    automation: { list: async () => ({ runs: [] }) },
    server: { listProviderUsage: async () => [] },
    todo: { list: fixture.listTodos },
  }),
}));
vi.mock("~/hooks/useActivityThreads", () => ({ useActivityThreads: fixture.activity }));

vi.mock("~/tasksSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/tasksSurface")>()),
  useTasksSurfaceEnabled: () => isBetaFeatureEnabled("tasks", "production"),
}));
vi.mock("../RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: import("react").ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../RouteSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../RouteSurface")>()),
  RouteSurfaceHeader: () => null,
}));

import InboxView from "./InboxView";
import { Route as inboxRoute } from "~/routes/_chat.inbox";

it("opens a Stable Inbox deep link", async () => {
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
    expect(router.state.location.pathname).toBe("/inbox");
    expect(mounted).toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("loads the Stable Inbox without offering or requesting Beta to-dos", async () => {
  fixture.navigate.mockReset();
  fixture.listTodos.mockReset();
  fixture.activity.mockReturnValue({ visibleNonGroupThreads: [] });
  fixture.getRecap.mockRejectedValue({ code: "FEATURE_UNAVAILABLE" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <InboxView />
    </QueryClientProvider>,
  );
  try {
    await expect.element(view.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    await expect
      .element(view.getByText("The day recap needs a newer Synara server."))
      .toBeVisible();
    expect(fixture.getRecap).toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.listTodos).not.toHaveBeenCalled();
    await expect
      .element(view.getByRole("heading", { name: "Today’s tasks" }))
      .not.toBeInTheDocument();
    await expect.element(view.getByRole("button", { name: "All tasks" })).not.toBeInTheDocument();
  } finally {
    await view.unmount();
    client.clear();
  }
});
