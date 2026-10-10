import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { useProjectImportDialogStore } from "../projectImport/projectImportDialogStore";
import { useProjectImportAnnouncement } from "../projectImport/useProjectImportAnnouncement";

const mocks = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock("../lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config"],
    queryFn: mocks.getConfig,
    staleTime: Infinity,
  }),
}));
const clients: QueryClient[] = [];
const storageKey = "synara:project-import-announcement:v1";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(storageKey);
  mocks.getConfig.mockReset().mockResolvedValue({ worktreesDir: "/first/worktrees" });
  useOnboardingDialogStore.setState({
    isOpen: false,
    openReason: null,
    engaged: false,
    startupGateSettled: false,
  });
  useProjectImportDialogStore.setState({ isOpen: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) client.clear();
  localStorage.removeItem(storageKey);
});
async function renderAnnouncement() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const hook = await renderHook(() => useProjectImportAnnouncement(), {
    wrapper: ({ children }: { children?: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, hook };
}

describe("project import announcement", () => {
  it("waits for the startup gate and persists dismissal separately for each installation", async () => {
    const { client, hook } = await renderAnnouncement();
    await vi.waitFor(() => expect(client.getQueryData(["server", "config"])).toBeDefined());
    expect(hook.result.current.visible).toBe(false);
    await act(async () => {
      useOnboardingDialogStore.getState().markStartupGateSettled();
    });
    await vi.waitFor(() => expect(hook.result.current.visible).toBe(true));
    await act(async () => {
      hook.result.current.markSeen();
    });
    expect(hook.result.current.visible).toBe(false);
    await act(async () => {
      client.setQueryData(["server", "config"], { worktreesDir: "/second/worktrees" });
    });
    await vi.waitFor(() => expect(hook.result.current.visible).toBe(true));
    await act(async () => {
      client.setQueryData(["server", "config"], { worktreesDir: "/first/worktrees" });
    });
    await vi.waitFor(() => expect(hook.result.current.visible).toBe(false));
    await hook.unmount();
  });

  it("does not announce again after the first-run tour already presented project import", async () => {
    useOnboardingDialogStore.setState({
      isOpen: true,
      openReason: "first-run",
      startupGateSettled: true,
    });
    const { hook } = await renderAnnouncement();
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toContain("/first/worktrees"),
    );
    await act(async () => {
      useOnboardingDialogStore.getState().close();
    });
    expect(hook.result.current.visible).toBe(false);
    await hook.unmount();
  });
});
