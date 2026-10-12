import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  installation: "/first/worktrees",
  api: {
    cookieSources: vi.fn(async () => [{ id: "chrome", name: "Google Chrome" }]),
    cookieProfiles: vi.fn(async () => [{ id: "Default", name: "Personal" }]),
  },
  navigate: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ browser: { vault: harness.api } }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("~/lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config"],
    queryFn: async () => ({ worktreesDir: harness.installation }),
    staleTime: Infinity,
  }),
}));

import { BrowserImportAnnouncementDialog } from "./BrowserImportAnnouncementDialog";
import { BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY } from "./useBrowserImportAnnouncement";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";

const clients: QueryClient[] = [];

beforeEach(() => {
  harness.installation = "/first/worktrees";
  harness.api.cookieSources
    .mockReset()
    .mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
  harness.api.cookieProfiles.mockReset().mockResolvedValue([{ id: "Default", name: "Personal" }]);
  harness.navigate.mockReset();
  localStorage.removeItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY);
  useOnboardingDialogStore.setState({
    isOpen: false,
    openReason: null,
    engaged: false,
    browserImportStepSeenForInstallation: null,
    startupGateSettled: true,
    betaWelcomePending: false,
  });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  localStorage.removeItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY);
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <BrowserImportAnnouncementDialog />
    </QueryClientProvider>,
  );
  return { screen, client };
}

it("routes existing users to the shared General settings panel and remembers the prompt", async () => {
  await show();
  await page.getByRole("button", { name: "Review browser import" }).click();

  expect(harness.navigate).toHaveBeenCalledWith({
    to: "/settings",
    search: { section: "general" },
  });
  expect(JSON.parse(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY) ?? "[]")).toEqual(
    ["/first/worktrees"],
  );
});

it("does not prompt when there are no browser profiles", async () => {
  harness.api.cookieProfiles.mockResolvedValue([]);
  await show();
  await expect.poll(() => harness.api.cookieProfiles.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the prompt available when a provisional first-run tour auto-closes before the import step", async () => {
  useOnboardingDialogStore.setState({ isOpen: true, startupGateSettled: true });
  await show();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY)).toBeNull();
  useOnboardingDialogStore.setState({ isOpen: false });
  await expect.element(page.getByRole("button", { name: "Review browser import" })).toBeVisible();
});

it("marks the prompt seen after onboarding displays its browser-import step for this installation", async () => {
  useOnboardingDialogStore.setState({
    isOpen: true,
    startupGateSettled: true,
    browserImportStepSeenForInstallation: "/first/worktrees",
  });
  await show();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .poll(() => JSON.parse(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY) ?? "[]"))
    .toEqual(["/first/worktrees"]);
});

it("waits for the first-run gate and remembers dismissal on this installation", async () => {
  useOnboardingDialogStore.setState({ startupGateSettled: false });
  const { screen } = await show();
  expect(harness.api.cookieSources).not.toHaveBeenCalled();
  useOnboardingDialogStore.setState({ startupGateSettled: true });
  await page.getByRole("button", { name: "Not now" }).click();
  expect(JSON.parse(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY) ?? "[]")).toEqual(
    ["/first/worktrees"],
  );
  await screen.unmount();
  await show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("keeps installation acknowledgments separate", async () => {
  localStorage.setItem(
    BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY,
    JSON.stringify(["/first/worktrees"]),
  );
  harness.installation = "/second/worktrees";
  await show();
  await expect.element(page.getByRole("button", { name: "Review browser import" })).toBeVisible();
});

it("does not apply a prior installation's onboarding step acknowledgment to a new installation", async () => {
  useOnboardingDialogStore.setState({
    isOpen: false,
    startupGateSettled: true,
    browserImportStepSeenForInstallation: "/first/worktrees",
  });
  const { client } = await show();
  await expect
    .poll(() => JSON.parse(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY) ?? "[]"))
    .toEqual(["/first/worktrees"]);

  client.setQueryData(["server", "config"], { worktreesDir: "/second/worktrees" });
  await expect.element(page.getByRole("button", { name: "Review browser import" })).toBeVisible();
  expect(JSON.parse(localStorage.getItem(BROWSER_IMPORT_ANNOUNCEMENT_STORAGE_KEY) ?? "[]")).toEqual(
    ["/first/worktrees"],
  );
});
