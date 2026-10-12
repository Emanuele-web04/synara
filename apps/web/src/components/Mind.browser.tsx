import "../index.css";
import { MindMemoryId, ProjectId, type MindMemory } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { Route } from "../routes/_chat.mind.index";

const state = vi.hoisted(() => ({
  api: { list: vi.fn(), search: vi.fn(), history: vi.fn(), affirm: vi.fn() },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ mind: state.api }) }));
vi.mock("~/store", () => ({
  useStore: (select: (value: { projects: unknown[] }) => unknown) => select({ projects: [] }),
}));
vi.mock("~/components/SidebarHeaderNavigationControls", () => ({
  SidebarHeaderNavigationControls: () => null,
}));
vi.mock("~/components/RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "",
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));
const memory: MindMemory = {
  memoryId: MindMemoryId.makeUnsafe("synthetic-memory"),
  projectId: ProjectId.makeUnsafe("synthetic-project"),
  text: "Project uses Bun",
  type: "semantic",
  weight: 0.6,
  accessCount: 0,
  pinned: false,
  createdAt: new Date().toISOString(),
  lastAccessedAt: new Date().toISOString(),
  provenance: { kind: "user" },
};
const result = (value = memory) => ({ memories: [value], count: 1, cap: 500 });
beforeEach(() => {
  vi.resetAllMocks();
  state.api.list.mockResolvedValue(result());
  state.api.search.mockResolvedValue(result());
  state.api.history.mockResolvedValue({ entries: [] });
});
async function mount() {
  const View = Route.options.component;
  if (!View) throw new Error("Mind route has no component");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Project uses Bun", { exact: true })).toBeVisible();
}
it("refreshes visible search results", async () => {
  await mount();
  await page.getByRole("textbox", { name: "Search memories" }).fill("Bun");
  await vi.waitFor(() => expect(state.api.search).toHaveBeenCalledTimes(1));
  const listCalls = state.api.list.mock.calls.length;
  state.api.search.mockResolvedValue(result({ ...memory, text: "Project uses Bun workspaces" }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .element(page.getByText("Project uses Bun workspaces", { exact: true }))
    .toBeVisible();
  expect(state.api.list).toHaveBeenCalledTimes(listCalls);
});
it("prevents a second pending affirm and refreshes open history after it settles", async () => {
  let finish: (() => void) | undefined;
  state.api.affirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(memory);
      }),
  );
  await mount();
  await page.getByRole("button", { name: "Show history" }).click();
  await vi.waitFor(() => expect(state.api.history).toHaveBeenCalledTimes(1));
  const affirm = page.getByRole("button", { name: "Still true" });
  await affirm.click();
  await expect.element(affirm).toBeDisabled();
  (affirm.element() as HTMLButtonElement).click();
  expect(state.api.affirm).toHaveBeenCalledTimes(1);
  state.api.history.mockResolvedValue({
    entries: [{ op: "confirm", actor: { kind: "user" }, createdAt: new Date().toISOString() }],
  });
  finish?.();
  await expect.element(page.getByText(/Confirmed ·/)).toBeVisible();
  await expect.element(affirm).toBeEnabled();
});
