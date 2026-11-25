// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { DesktopBridge } from "@synara/contracts";

import { setDesktopQuitAsks } from "~/hooks/useDesktopQuitPreference";

const harness = vi.hoisted(() => ({
  config: {
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
  },
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

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[0] === "config" ? harness.config : harness.auth,
  }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
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

describe("AdvancedSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete window.desktopBridge;
    setDesktopQuitAsks(true);
  });

  it("turns the idle quit question on and off from Advanced", async () => {
    const setQuitAsks = vi.fn(async () => undefined);
    window.desktopBridge = {
      getQuitAsks: async () => true,
      setQuitAsks,
    } as Pick<DesktopBridge, "getQuitAsks" | "setQuitAsks"> as DesktopBridge;

    await render(<AdvancedSettingsPanel active resetEpoch={0} />);

    const quitSwitch = page.getByRole("switch", { name: "Ask before quitting" });
    await expect.element(quitSwitch).toBeVisible();
    await quitSwitch.click();

    expect(setQuitAsks).toHaveBeenCalledWith(false);
  });

  it("owns recovery eligibility and shared disclosure motion", async () => {
    await render(<AdvancedSettingsPanel active resetEpoch={0} />);

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
    await render(<AboutSettingsSection onOpenReleaseHistory={onOpenReleaseHistory} />);

    await page.getByRole("button", { name: "View release history" }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
  });

  it("replays the app tour from the workspace, where its controls are on screen", async () => {
    useFeatureTourStore.getState().close();
    await render(<AppTourSettingsRow />);

    await page.getByRole("button", { name: "Replay tour" }).click();

    expect(harness.navigate).toHaveBeenCalledWith({ to: "/" });
    await vi.waitFor(() => expect(useFeatureTourStore.getState().replay).toBe(true));
    useFeatureTourStore.getState().close();
  });
});
