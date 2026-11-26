import "../index.css";

import type { AccountStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import {
  PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY,
  ProductAnalyticsAnnouncement,
} from "./ProductAnalyticsAnnouncement";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  bridge: null as { getState: () => Promise<{ enabled: boolean }> } | null,
  enabled: true,
  status: { state: "signed-out" } as AccountStatus,
  accountPending: false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({
    status: fixture.status,
    statusQuery: { isPending: fixture.accountPending },
  }),
}));
vi.mock("~/lib/productAnalytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/productAnalytics")>()),
  productAnalyticsBridge: () => fixture.bridge,
}));

const TITLE = "Synara shares anonymous usage data";
const clients: QueryClient[] = [];
const acknowledged = () =>
  JSON.parse(localStorage.getItem(PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY) ?? "null");

async function renderAnnouncement() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProductAnalyticsAnnouncement />
    </QueryClientProvider>,
  );
}

describe("ProductAnalyticsAnnouncement", () => {
  beforeEach(() => {
    localStorage.removeItem(PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY);
    fixture.navigate.mockReset();
    fixture.enabled = true;
    fixture.status = { state: "signed-out" };
    fixture.accountPending = false;
    fixture.bridge = { getState: async () => ({ enabled: fixture.enabled }) };
    useOnboardingDialogStore.setState({
      isOpen: false,
      startupGateSettled: true,
      betaWelcomePending: false,
    });
    useAnnouncementSheetSlotStore.setState({
      owner: null,
      handedOff: false,
      startupSettled: true,
      pending: [],
    });
  });
  afterEach(async () => {
    await cleanup();
    for (const client of clients.splice(0)) client.clear();
    localStorage.removeItem(PRODUCT_ANALYTICS_ANNOUNCEMENT_STORAGE_KEY);
    useOnboardingDialogStore.setState(useOnboardingDialogStore.getInitialState(), true);
    useAnnouncementSheetSlotStore.setState(useAnnouncementSheetSlotStore.getInitialState(), true);
  });

  it("explains what is shared and opens Settings › Privacy to turn it off, once", async () => {
    await renderAnnouncement();
    const sheet = page.getByRole("dialog", { name: TITLE });
    await expect.element(sheet.getByText("Never shared")).toBeVisible();
    await expect
      .element(sheet.getByText("Prompts, chats, files, paths or project names"))
      .toBeVisible();

    await sheet.getByRole("button", { name: "Turn off in Settings" }).click();

    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/settings",
      search: { section: "privacy" },
    });
    expect(acknowledged()).toEqual({ acknowledged: true });
    await expect.element(sheet).not.toBeInTheDocument();
  });

  it("closes for good on Got it without leaving the page", async () => {
    await renderAnnouncement();
    await page.getByRole("button", { name: "Got it" }).click();

    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(acknowledged()).toEqual({ acknowledged: true });
    await expect.element(page.getByRole("dialog", { name: TITLE })).not.toBeInTheDocument();
  });

  it("counts an existing opt-out as seen, so re-enabling sharing never pops the sheet", async () => {
    fixture.enabled = false;
    await renderAnnouncement();
    await expect.poll(acknowledged).toEqual({ acknowledged: true });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits until the account has loaded, so team sharing consent can't open underneath", async () => {
    fixture.accountPending = true;
    await renderAnnouncement();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(acknowledged()).toBeNull();
  });

  it("stays hidden without the desktop analytics bridge", async () => {
    fixture.bridge = null;
    await renderAnnouncement();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(acknowledged()).toBeNull();
  });
});
