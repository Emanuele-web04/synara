import {
  createLazyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { usePreloadRouteChunks } from "./usePreloadRouteChunks";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("warms the thread chunk while a different route navigates", async () => {
  const chunkStarted = deferred();
  const chunkReady = deferred();
  const root = createRootRoute({
    component: function TestRoot() {
      usePreloadRouteChunks();
      return <Outlet />;
    },
  });
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const landing = createRoute({
    getParentRoute: () => chat,
    path: "/",
    component: () => <p>Start page</p>,
  });
  const settings = createRoute({
    getParentRoute: () => chat,
    path: "/settings",
    component: () => <p>Settings page</p>,
  });
  const thread = createRoute({
    getParentRoute: () => chat,
    path: "/$threadId",
  }).lazy(async () => {
    chunkStarted.resolve();
    await chunkReady.promise;
    return createLazyRoute("/_chat/$threadId")({ component: () => <p>Thread page</p> });
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([landing, settings, thread])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const errors = vi.spyOn(console, "error");
  try {
    const screen = await render(<RouterProvider router={router} />);
    await expect.element(screen.getByText("Start page")).toBeVisible();
    await chunkStarted.promise;
    await router.navigate({ to: "/settings" });
    await expect.element(screen.getByText("Settings page")).toBeVisible();

    chunkReady.resolve();
    await router.navigate({ to: "/$threadId", params: { threadId: "actual-thread" } });
    await expect.element(screen.getByText("Thread page")).toBeVisible();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    chunkReady.resolve();
    errors.mockRestore();
  }
});
