import "../../index.css";

import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import type { HostEnrollment } from "~/lib/hosts/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useAnnouncementSheetSlotStore } from "../announcementSheetSlot";
import { OneTimeCoachmark } from "../OneTimeCoachmark";
import { useOnboardingDialogStore } from "../../onboarding/onboardingDialogStore";
import {
  REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY,
  REMOTE_CONNECTIONS_COACHMARK_STORAGE_KEY,
  RemoteConnectionsAnnouncement,
  RemoteConnectionsCoachmark,
} from "./RemoteConnectionsAnnouncement";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  remoteConnections: true,
  remote: null as object | null,
  status: { state: "signed-out" } as AccountStatus,
  billing: { access: "none" } as Pick<AccountBillingStatus, "access">,
  billingResponse: null as Promise<Pick<AccountBillingStatus, "access">> | null,
  enrollment: { host: null } as Partial<HostEnrollment>,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
  useRouterState: () => false,
}));
vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({ status: fixture.status, statusQuery: { isPending: false } }),
}));
vi.mock("~/lib/hosts/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/queries")>()),
  remoteHostEnrollmentQueryOptions: (input: { enabled?: boolean }) => ({
    queryKey: ["hosts", "enrollment"],
    enabled: input.enabled ?? true,
    queryFn: async () => fixture.enrollment,
  }),
}));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: { capabilities: { remoteConnections: fixture.remoteConnections } },
    remote: fixture.remote,
  }),
}));
vi.mock("~/lib/accountBilling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/accountBilling")>()),
  ACCOUNT_BILLING_ENABLED: true,
}));
vi.mock("~/lib/accountReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/accountReactQuery")>()),
  accountBillingQueryOptions: (status: AccountStatus | null) => ({
    queryKey: ["account", "billing", status?.state ?? "signed-out"],
    enabled: status?.state === "signed-in",
    queryFn: async () => fixture.billingResponse ?? fixture.billing,
  }),
}));

const clients: QueryClient[] = [];
const signedIn: AccountStatus = {
  state: "signed-in",
  accountAuthority: "https://accounts.example.com",
  me: {
    id: "user_a",
    name: "Tester",
    email: "tester@example.com",
    organization: { id: "org_a", name: "Team" },
  },
};
// A team machine whose owner has not answered the sharing consent yet.
const consentOwed: Partial<HostEnrollment> = {
  host: { id: "host_a", name: "Mac Studio" } as HostEnrollment["host"],
  discoverabilityAcknowledged: false,
  organizationMemberCount: 3,
};
const acknowledged = () =>
  JSON.parse(localStorage.getItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY) ?? "null");

async function renderAnnouncement(showOtherHint = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <RemoteConnectionsAnnouncement />
      <RemoteConnectionsCoachmark signedIn={false} tooltip="Sign in">
        <button type="button">Account</button>
      </RemoteConnectionsCoachmark>
      {showOtherHint && (
        <OneTimeCoachmark
          storageKey="test:other-startup-hint"
          title="Other startup hint"
          description="This hint must appear first."
          tooltip="Other"
        >
          <button type="button">Other feature</button>
        </OneTimeCoachmark>
      )}
    </QueryClientProvider>,
  );
}

describe("RemoteConnectionsAnnouncement", () => {
  beforeEach(() => {
    localStorage.removeItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY);
    localStorage.removeItem(REMOTE_CONNECTIONS_COACHMARK_STORAGE_KEY);
    fixture.navigate.mockReset();
    fixture.remoteConnections = true;
    fixture.remote = null;
    fixture.status = { state: "signed-out" };
    fixture.billing = { access: "none" };
    fixture.billingResponse = null;
    fixture.enrollment = { host: null };
    localStorage.removeItem("test:other-startup-hint");
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
  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
    localStorage.removeItem(REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY);
  });

  it("sends people without Alto to the plans, once, with no hint over that page", async () => {
    await renderAnnouncement();
    await page.getByRole("button", { name: "View Alto plans" }).click();

    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "usage", target: "settings-synara-plan" },
    });
    expect(acknowledged()).toEqual({ acknowledged: true });
    await expect
      .element(page.getByRole("dialog", { name: "Introducing Remote Connections" }))
      .not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect.element(page.getByText("Sign in to connect")).not.toBeInTheDocument();
  });

  it("waits for an existing Alto subscriber’s billing result before opening Connections", async () => {
    fixture.status = signedIn;
    let resolveBilling!: (billing: Pick<AccountBillingStatus, "access">) => void;
    fixture.billingResponse = new Promise((resolve) => {
      resolveBilling = resolve;
    });
    await renderAnnouncement();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    resolveBilling({ access: "granted" });
    await page.getByRole("button", { name: "Connect a device" }).click();

    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "connections" },
    });
  });

  it("closes from the hero's close button, then points at the account button", async () => {
    await renderAnnouncement();
    await expect.element(page.getByText("Sign in to connect")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Close" }).click();

    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(acknowledged()).toEqual({ acknowledged: true, pointToAccount: true });
    await expect
      .element(page.getByRole("dialog", { name: "Introducing Remote Connections" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Sign in to connect")).toBeVisible();
    expect(localStorage.getItem(REMOTE_CONNECTIONS_COACHMARK_STORAGE_KEY)).toBe("seen");
  });

  it("opens only after the other startup surfaces are done", async () => {
    useAnnouncementSheetSlotStore.setState({ startupSettled: false });
    await renderAnnouncement(true);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    useAnnouncementSheetSlotStore.setState({ startupSettled: true });
    await expect.element(page.getByText("Other startup hint")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Other feature" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Introducing Remote Connections" }))
      .toBeVisible();
  });

  it("stands aside while the team sharing consent is owed, then opens", async () => {
    fixture.status = signedIn;
    fixture.enrollment = consentOwed;
    await renderAnnouncement();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    clients.at(-1)?.setQueryData(["hosts", "enrollment"], {
      ...consentOwed,
      discoverabilityAcknowledged: true,
    });
    await expect
      .element(page.getByRole("dialog", { name: "Introducing Remote Connections" }))
      .toBeVisible();
  });

  it("stays hidden in a window that is already controlling another computer", async () => {
    fixture.remote = { userId: "user_a" };
    await renderAnnouncement();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Account" }).hover();
    await expect.element(page.getByText("Sign in", { exact: true })).toBeVisible();
  });

  it("counts the first-run tour, which pairs a device itself, as the announcement", async () => {
    useOnboardingDialogStore.setState({ isOpen: true });
    await renderAnnouncement();
    await expect.poll(acknowledged).toEqual({ acknowledged: true });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
