import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useFeatureTourStore } from "~/featureTour/store";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { ProjectImportAnnouncementDialog } from "~/projectImport/ProjectImportAnnouncementDialog";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { FeatureTourDialog } from "./FeatureTourDialog";
import { AppSnapWelcomeDialog } from "./AppSnapWelcomeDialog";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

let installation = "/first/worktrees";
let flavor: "production" | "beta" = "production";
vi.mock("../lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config", installation],
    queryFn: async () => ({ worktreesDir: installation }),
    staleTime: Infinity,
  }),
}));
vi.mock("../betaFeatures", () => ({
  isBetaFeatureOn: (feature: string) => isBetaFeatureEnabled(feature, flavor),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const tourKey = "synara:feature-tour:since-0.9.2:v1";
const importKey = "synara:project-import-announcement:v1";
const clients: QueryClient[] = [];
const screens: Awaited<ReturnType<typeof render>>[] = [];
const originalBridge = window.desktopBridge;

beforeEach(async () => {
  await page.viewport(1280, 900);
  installation = "/first/worktrees";
  flavor = "production";
  localStorage.removeItem(tourKey);
  localStorage.setItem(importKey, JSON.stringify([installation]));
  localStorage.removeItem("synara:appsnap-welcome:v1");
  useOnboardingDialogStore.setState({
    isOpen: false,
    startupGateSettled: true,
    betaWelcomePending: false,
  });
  useProjectImportDialogStore.setState({ isOpen: false });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  useFeatureTourStore.setState({ replay: false });
});
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  for (const client of clients.splice(0)) client.clear();
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  localStorage.removeItem(tourKey);
  localStorage.removeItem(importKey);
  localStorage.removeItem("synara:appsnap-welcome:v1");
});
async function show(children = <FeatureTourDialog />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
  screens.push(screen);
  return screen;
}

it("navigates Stable highlights, remembers dismissal per installation, and replays after a handoff", async () => {
  const screen = await show();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page
    .getByRole("dialog")
    .screenshot({ path: "node_modules/.cache/feature-tour-desktop.png" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "Your agents, together" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show From review to the next change" }).click();
  await expect.element(page.getByRole("button", { name: "Start exploring" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show Give bigger work a team" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Start exploring" }).click();
  await screen.unmount();
  screens.splice(screens.indexOf(screen), 1);
  await show();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  useAnnouncementSheetSlotStore.setState({ handedOff: true });
  useFeatureTourStore.getState().open();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("announces again when the browser connects to a different installation", async () => {
  localStorage.setItem(tourKey, JSON.stringify([installation]));
  installation = "/second/worktrees";
  localStorage.setItem(importKey, JSON.stringify([installation]));
  await show();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  expect(JSON.parse(localStorage.getItem(tourKey) ?? "[]")).toEqual([
    "/first/worktrees",
    "/second/worktrees",
  ]);
});

it("shows Beta highlights and waits for onboarding and other modal flows to close", async () => {
  flavor = "beta";
  useOnboardingDialogStore.setState({ startupGateSettled: false });
  function Flow() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Dialog open={open}>
          <DialogPopup>
            <DialogTitle>Existing setup</DialogTitle>
            <Button onClick={() => setOpen(false)}>Finish setup</Button>
          </DialogPopup>
        </Dialog>
        <FeatureTourDialog />
      </>
    );
  }
  await show(<Flow />);
  useOnboardingDialogStore.getState().markStartupGateSettled();
  await expect.element(page.getByRole("dialog", { name: "Existing setup" })).toBeVisible();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.getByRole("button", { name: "Show Give bigger work a team" }).click();
  await expect.element(page.getByRole("dialog", { name: "Give bigger work a team" })).toBeVisible();
  await page.getByRole("button", { name: "Start exploring" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("waits for project import announcements instead of racing their shared slot", async () => {
  localStorage.removeItem(importKey);
  await show(
    <>
      <ProjectImportAnnouncementDialog />
      <FeatureTourDialog />
    </>,
  );
  await expect.element(page.getByRole("dialog", { name: "Import projects" })).toBeVisible();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
});

it("does not jump ahead of a slow AppSnap probe and then waits for its dismissal", async () => {
  let resolveProbe!: (value: { supported: true }) => void;
  window.desktopBridge = {
    ...originalBridge,
    appSnap: {
      getState: () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;
  await show(
    <AppSnapWelcomeDialog>
      <FeatureTourDialog />
    </AppSnapWelcomeDialog>,
  );
  // A full quiet interval passes while the real owner is still probing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  resolveProbe({ supported: true });
  await expect
    .element(page.getByRole("dialog", { name: "Synara AppSnaps are live!" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
});

it("keeps the tour usable on a narrow screen and with large UI text", async () => {
  await page.viewport(390, 700);
  const sizes = {
    "--app-font-size-ui": 18,
    "--app-font-size-ui-lg": 19,
    "--app-font-size-ui-sm": 17,
    "--app-font-size-ui-xs": 15,
  };
  for (const [key, value] of Object.entries(sizes))
    document.documentElement.style.setProperty(key, `${value}px`);
  try {
    await show();
    await expect
      .element(page.getByRole("dialog", { name: "A new home for your work" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const dialog = document.querySelector("[data-feature-tour]") as HTMLElement;
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    const points = dialog.querySelector("ul")!.getBoundingClientRect();
    const footer = dialog.querySelector("[data-slot=dialog-footer]")!.getBoundingClientRect();
    expect(footer.top).toBeGreaterThanOrEqual(points.bottom);
    await page
      .getByRole("dialog")
      .screenshot({ path: "node_modules/.cache/feature-tour-mobile.png" });
    await page.getByRole("button", { name: "Skip tour" }).click();
  } finally {
    for (const key of Object.keys(sizes)) document.documentElement.style.removeProperty(key);
    await page.viewport(1280, 900);
  }
});

it("restores manual replay focus after keyboard navigation and Escape", async () => {
  localStorage.setItem(tourKey, JSON.stringify([installation]));
  await show(
    <>
      <Button onClick={() => useFeatureTourStore.getState().open()}>Replay highlights</Button>
      <FeatureTourDialog />
    </>,
  );
  await page.getByRole("button", { name: "Replay highlights" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("dialog", { name: "Your agents, together" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Replay highlights" }).element(),
    ),
  );
});

it("closes an automatic tour when another window acknowledges this installation", async () => {
  await show();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  const value = JSON.stringify([installation]);
  localStorage.setItem(tourKey, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key: tourKey, newValue: value, storageArea: localStorage }),
  );
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
