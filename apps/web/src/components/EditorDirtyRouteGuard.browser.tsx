import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { writeFile, notify } = vi.hoisted(() => ({ writeFile: vi.fn(), notify: vi.fn() }));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ projects: { writeFile } }) }));
vi.mock("./ui/toast", () => ({ toastManager: { add: notify } }));
import { EditorDirtyRouteGuard } from "./EditorDirtyRouteGuard";
import { getWorkspaceEditorSession } from "~/lib/workspaceEditorSession";

async function mount() {
  writeFile.mockReset();
  notify.mockReset();
  const client = new QueryClient();
  const session = getWorkspaceEditorSession(client, "/repo", "file.ts");
  const unsubscribe = session.subscribe(() => undefined);
  session.load({
    relativePath: "file.ts",
    contents: "original",
    version: "sha256:initial",
    encoding: "utf8",
    lineEnding: "lf",
    truncated: false,
  });
  const root = createRootRoute({
    component: () => (
      <>
        <EditorDirtyRouteGuard />
        <Outlet />
      </>
    ),
  });
  const editor = createRoute({
    getParentRoute: () => root,
    path: "/editor",
    component: () => (
      <button onClick={() => void router.navigate({ to: "/settings" })}>Next page</button>
    ),
  });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Next page content</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([editor, next]),
    history: createMemoryHistory({ initialEntries: ["/editor"] }),
  });
  const view = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    router,
    session,
    close: async () => {
      unsubscribe();
      await view.unmount();
      client.clear();
    },
  };
}

it("saves the latest buffer before allowing navigation", async () => {
  const { router, session, close } = await mount();
  let finish!: (value: { relativePath: string; version: string }) => void;
  writeFile
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ relativePath: "file.ts", version: "sha256:last" });
  session.change("first");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => writeFile.mock.calls.length).toBe(1);
  expect(router.state.location.pathname).toBe("/editor");
  session.change("latest");
  finish({ relativePath: "file.ts", version: "sha256:first" });
  await expect.poll(() => router.state.location.pathname).toBe("/settings");
  expect(writeFile).toHaveBeenLastCalledWith(
    expect.objectContaining({ contents: "latest", expectedVersion: "sha256:first" }),
  );
  expect(session.dirty).toBe(false);
  await close();
});

it("keeps navigation blocked and preserves the draft when saving fails", async () => {
  const { router, session, close } = await mount();
  writeFile.mockRejectedValue(new Error("Permission denied"));
  session.change("mine");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => notify.mock.calls.length).toBe(1);
  expect(router.state.location.pathname).toBe("/editor");
  expect(session.getSnapshot().value).toBe("mine");
  expect(session.getSnapshot().saveError).toBe("Permission denied");
  await page.getByRole("button", { name: "Next page" }).click();
  expect(writeFile).toHaveBeenCalledTimes(1);
  await close();
});
