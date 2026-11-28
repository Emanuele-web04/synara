// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  auth: { authenticated: true, role: "client" },
  threadShells: [] as unknown[],
  allThreadsMessageless: false,
  projects: [{ id: "project-1" }],
  threadsHydrated: true,
  syncServerReadModel: vi.fn(),
  navigate: vi.fn((_options: { to: string }) => Promise.resolve()),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => harness.navigate,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[1] === "settings" ? undefined : harness.auth,
  }),
}));

vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({ queryKey: ["config"] }),
  serverAuthSessionQueryOptions: () => ({ queryKey: ["auth"] }),
}));

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
  createAllThreadsMessagelessSelector: () => () => harness.allThreadsMessageless,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      threadsHydrated: harness.threadsHydrated,
      syncServerReadModel: harness.syncServerReadModel,
    }),
}));

import { useFeatureTourStore } from "~/featureTour/store";
import {
  AboutSettingsSection,
  AdvancedSettingsPanel,
  AppTourSettingsRow,
} from "./AdvancedSettingsPanel";

function renderPanel(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

describe("AdvancedSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("owns recovery eligibility and shared disclosure motion", async () => {
    await renderPanel(<AdvancedSettingsPanel active resetEpoch={0} />);

    const repairButton = page.getByRole("button", { name: "Repair state" });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain("Authenticated as client.");

    const disclosureButton = page.getByRole("button", { name: "What this does" });
    expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("false");
    const disclosureShell = disclosureButton.element().parentElement?.querySelector("div[inert]");
    expect(disclosureShell?.className).toContain("duration-220");
    await disclosureButton.click();
    await vi.waitFor(() =>
      expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("true"),
    );

    // Version, release history, and the app tour now live on About and General.
    expect(page.getByRole("button", { name: "View release history" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Replay tour" }).elements()).toHaveLength(0);
  });

  it("hands release history off from the About section", async () => {
    const onOpenReleaseHistory = vi.fn();
    await renderPanel(<AboutSettingsSection onOpenReleaseHistory={onOpenReleaseHistory} />);

    await page.getByRole("button", { name: "View release history" }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
  });

  it("replays the app tour from the workspace, where its controls are on screen", async () => {
    useFeatureTourStore.getState().close();
    await renderPanel(<AppTourSettingsRow />);

    await page.getByRole("button", { name: "Replay tour" }).click();

    expect(harness.navigate).toHaveBeenCalledWith({ to: "/" });
    await vi.waitFor(() => expect(useFeatureTourStore.getState().replay).toBe(true));
    useFeatureTourStore.getState().close();
  });
});
