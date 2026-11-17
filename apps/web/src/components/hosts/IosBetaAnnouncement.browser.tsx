import "../../index.css";

import type { AccountStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { useAnnouncementSheetSlotStore } from "../announcementSheetSlot";
import { useOnboardingDialogStore } from "../../onboarding/onboardingDialogStore";
import {
  ConnectionLaunchAnnouncements,
  IOS_BETA_ANNOUNCEMENT_STORAGE_KEY,
} from "./IosBetaAnnouncement";
import { REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY } from "./RemoteConnectionsAnnouncement";

const fixture = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
  remoteConnections: true,
  remote: null as object | null,
  status: { state: "signed-out" } as AccountStatus,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => false,
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({ shell: { openExternal: fixture.openExternal } }),
}));
vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({ status: fixture.status, statusQuery: { isPending: false } }),
}));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: { capabilities: { remoteConnections: fixture.remoteConnections } },
    remote: fixture.remote,
  }),
}));

const TITLE = "Introducing Synara for iPhone";
const REMOTE_TITLE = "Introducing Remote Connections";
const clients: QueryClient[] = [];
const acknowledged = () =>
  JSON.parse(localStorage.getItem(IOS_BETA_ANNOUNCEMENT_STORAGE_KEY) ?? "null");

async function renderAnnouncement() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ConnectionLaunchAnnouncements />
    </QueryClientProvider>,
  );
}

describe("IosBetaAnnouncement", () => {
  beforeEach(() => {
    localStorage.removeItem(IOS_BETA_ANNOUNCEMENT_STORAGE_KEY);
    localStorage.removeItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY);
    fixture.openExternal.mockClear();
    fixture.remoteConnections = true;
    fixture.remote = null;
    fixture.status = { state: "signed-out" };
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
    localStorage.removeItem(IOS_BETA_ANNOUNCEMENT_STORAGE_KEY);
    localStorage.removeItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY);
    useOnboardingDialogStore.setState(useOnboardingDialogStore.getInitialState(), true);
    useAnnouncementSheetSlotStore.setState(useAnnouncementSheetSlotStore.getInitialState(), true);
  });

  it("opens the iPhone page from the call to action, once", async () => {
    await renderAnnouncement();
    await page.getByRole("button", { name: "Join the beta" }).click();

    expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith("https://trysynara.com/ios");
    expect(acknowledged()).toEqual({ acknowledged: true });
    await expect.element(page.getByRole("dialog", { name: TITLE })).not.toBeInTheDocument();
  });

  it("defers the Remote Connections sheet until the next launch after dismissing iPhone", async () => {
    const first = await renderAnnouncement();
    const iphone = page.getByRole("dialog", { name: TITLE });
    const remote = page.getByRole("dialog", { name: REMOTE_TITLE });
    await expect.element(iphone).toBeVisible();
    await expect.element(remote).not.toBeInTheDocument();
    await iphone.getByRole("button", { name: "Not now" }).click();
    expect(fixture.openExternal).not.toHaveBeenCalled();
    expect(acknowledged()).toEqual({ acknowledged: true });
    await expect.element(iphone).not.toBeInTheDocument();
    await expect.element(remote).not.toBeInTheDocument();
    expect(localStorage.getItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY)).toBeNull();
    await first.unmount();

    useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
    await renderAnnouncement();
    await expect
      .element(remote.getByText("The iPhone app is now in beta.", { exact: false }))
      .toBeVisible();
    await expect.element(iphone).not.toBeInTheDocument();
  });

  it("stays hidden where this computer cannot pair an iPhone", async () => {
    fixture.remoteConnections = false;
    await renderAnnouncement();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(acknowledged()).toBeNull();
  });

  it("counts the first-run tour, which introduces the iPhone app, as the announcement", async () => {
    useOnboardingDialogStore.setState({ isOpen: true });
    await renderAnnouncement();
    await expect.poll(acknowledged).toEqual({ acknowledged: true });
    expect(
      JSON.parse(localStorage.getItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY) ?? "null"),
    ).toEqual({ acknowledged: true });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
