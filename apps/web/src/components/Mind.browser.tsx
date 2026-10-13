import "../index.css";
import { MindMemoryId, ProjectId, type MindMemory } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { Route } from "../routes/_chat.mind.index";

const state = vi.hoisted(() => ({
  authSession: {
    authenticated: true,
    role: "owner" as "owner" | "client" | undefined,
    auth: {
      policy: "desktop-managed-local",
      authEnabled: false,
      bootstrapMethods: ["desktop-bootstrap"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "synara-session",
    },
  } as {
    authenticated: boolean;
    role?: "owner" | "client";
    auth: {
      policy: string;
      authEnabled: boolean;
      bootstrapMethods: string[];
      sessionMethods: string[];
      sessionCookieName: string;
    };
  },
  api: { list: vi.fn(), search: vi.fn(), history: vi.fn(), affirm: vi.fn() },
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    mind: state.api,
    server: { getAuthSession: async () => state.authSession },
  }),
}));
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
  state.authSession = {
    authenticated: true,
    role: "owner",
    auth: {
      policy: "desktop-managed-local",
      authEnabled: false,
      bootstrapMethods: ["desktop-bootstrap"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "synara-session",
    },
  };
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
it("keeps search usable when the initial list request fails", async () => {
  state.api.list.mockRejectedValue(new Error("List request failed"));
  state.api.search.mockResolvedValue(result({ ...memory, text: "Search works independently" }));
  const View = Route.options.component!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("List request failed")).toBeVisible();
  await page.getByRole("textbox", { name: "Search memories" }).fill("independently");
  await expect.element(page.getByText("Search works independently", { exact: true })).toBeVisible();
  await expect.element(page.getByText("List request failed")).not.toBeInTheDocument();
});
it("keeps search usable while the initial list request is pending", async () => {
  state.api.list.mockImplementation(() => new Promise(() => {}));
  state.api.search.mockResolvedValue(result({ ...memory, text: "Search works while loading" }));
  const View = Route.options.component!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Loading memories...")).toBeVisible();
  await page.getByRole("textbox", { name: "Search memories" }).fill("while loading");
  await expect.element(page.getByText("Search works while loading", { exact: true })).toBeVisible();
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

it("bounds pasted searches before sending an RPC", async () => {
  await mount();
  await page.getByRole("textbox", { name: "Search memories" }).fill("x".repeat(300));
  await vi.waitFor(() => expect(state.api.search).toHaveBeenCalled());
  expect(state.api.search.mock.calls[0]?.[0].query.length).toBe(200);
});
it("keeps every affirm row disabled while a confirmation is pending", async () => {
  state.api.list.mockResolvedValue({
    memories: [
      memory,
      { ...memory, memoryId: MindMemoryId.makeUnsafe("second-memory"), text: "Second fact" },
    ],
    count: 2,
    cap: 500,
  });
  state.api.affirm.mockImplementation(() => new Promise(() => {}));
  await mount();
  const buttons = page.getByRole("button", { name: "Still true" });
  await buttons.nth(0).click();
  await expect.element(buttons.nth(0)).toBeDisabled();
  await expect.element(buttons.nth(1)).toBeDisabled();
});
it("does not query owner-only Mind from a paired browser", async () => {
  state.authSession = { ...state.authSession, authenticated: true, role: "client" };
  const View = Route.options.component!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByText("Mind is available only to the workspace owner."))
    .toBeVisible();
  expect(state.api.list).not.toHaveBeenCalled();
  expect(state.api.search).not.toHaveBeenCalled();
});

it("loads Mind for a local auth-disabled owner without a browser session", async () => {
  state.authSession = {
    authenticated: false,
    auth: {
      policy: "desktop-managed-local",
      authEnabled: false,
      bootstrapMethods: ["desktop-bootstrap"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "synara-session",
    },
  };
  await mount();
  expect(state.api.list).toHaveBeenCalledOnce();
});
