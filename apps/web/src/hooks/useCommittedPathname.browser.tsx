import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { memo } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useCommittedPathname } from "./useCommittedPathname";

it("renders a shell subscriber once per navigation with matching pathname and params", async () => {
  const renders: Array<{ pathname: string; threadId: string | null }> = [];
  // Memoized like the compiled shell, so only its own subscriptions re-render it.
  const Shell = memo(function Shell() {
    renders.push({
      pathname: useCommittedPathname(),
      threadId: useParams({ strict: false, select: (params) => params.threadId ?? null }),
    });
    return null;
  });
  const root = createRootRoute({
    component: () => (
      <>
        <Shell />
        <Outlet />
      </>
    ),
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: "/$threadId",
    component: () => <p>Thread</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: ["/thread-a"] }),
  });
  const view = await render(<RouterProvider router={router} />);

  try {
    await expect
      .poll(() => renders.at(-1))
      .toEqual({ pathname: "/thread-a", threadId: "thread-a" });
    renders.length = 0;

    await router.navigate({ to: "/$threadId", params: { threadId: "thread-b" } });
    await expect.poll(() => router.state.status).toBe("idle");

    // `useLocation` here renders twice, the first time with "/thread-b" and "thread-a".
    expect(renders).toEqual([{ pathname: "/thread-b", threadId: "thread-b" }]);
  } finally {
    await view.unmount();
  }
});
