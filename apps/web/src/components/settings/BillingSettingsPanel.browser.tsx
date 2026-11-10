import "../../index.css";
import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { BillingSettingsPanel, SynaraPlanLink } from "./BillingSettingsPanel";

const fixture = vi.hoisted(() => ({
  status: { state: "signed-out" } as AccountStatus,
  billing: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
  open: vi.fn(),
  signIn: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("~/hooks/useAccount", () => ({ useAccount: () => ({ status: fixture.status }) }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => null,
  ensureNativeApi: () => ({
    account: {
      status: async () => fixture.status,
      billingStatus: fixture.billing,
      billingCheckout: fixture.checkout,
      billingPortal: fixture.portal,
    },
    shell: { openExternal: fixture.open },
  }),
}));
vi.mock("../account/accountDialogStore", () => ({
  useAccountDialogStore: { getState: () => ({ openSignIn: fixture.signIn }) },
}));

const disabled: AccountBillingStatus = {
  provider: "polar",
  environment: "sandbox",
  available: false,
  access: "none",
  subscriptionStatus: null,
  validUntil: null,
  cancelAtPeriodEnd: false,
  checkedAt: null,
  plans: [],
  canCheckout: false,
  canManage: false,
};
function signedIn(id = "user_a"): AccountStatus {
  return {
    state: "signed-in",
    accountAuthority: "https://accounts.example.com",
    me: {
      id,
      name: "Tester",
      email: "tester@example.com",
      organization: { id: "org_a", name: "Personal" },
    },
  };
}
/** Each plan card opens its own checkout. */
async function choosePlan(interval: "Monthly" | "Annual") {
  await page.getByRole("button", { name: new RegExp(`^${interval}`) }).click();
}
function panel(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <BillingSettingsPanel />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.status = signedIn();
  fixture.billing.mockResolvedValue(disabled);
  fixture.checkout.mockResolvedValue({
    environment: "sandbox",
    url: "https://sandbox.polar.sh/checkout/test",
  });
  fixture.open.mockResolvedValue(true);
});

describe("Synara Alto settings", () => {
  it("offers sign in without fetching billing while signed out", async () => {
    fixture.status = { state: "signed-out" };
    await render(panel(new QueryClient()));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(fixture.signIn).toHaveBeenCalledOnce();
    expect(fixture.billing).not.toHaveBeenCalled();
  });

  it("keeps unconfigured billing harmless and clearly labeled", async () => {
    await render(panel(new QueryClient()));
    await expect.element(page.getByText("Test billing is not configured")).toBeVisible();
    await expect.element(page.getByText("Sandbox", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Monthly/ })).not.toBeInTheDocument();
  });

  it("shows a card per plan and opens only a test checkout for the chosen interval", async () => {
    fixture.billing.mockResolvedValue({
      ...disabled,
      available: true,
      canCheckout: true,
      plans: [{ interval: "year", amountMinor: 12345, currency: "USD" }],
    });
    await render(panel(new QueryClient()));
    await expect
      .element(page.getByRole("button", { name: /^Annual/ }))
      .toHaveTextContent("Annual$123.45 / year");
    await choosePlan("Annual");
    await expect.poll(() => fixture.open.mock.calls.length).toBe(1);
    expect(fixture.checkout).toHaveBeenCalledWith({ interval: "year" });
    expect(fixture.open).toHaveBeenCalledWith("https://sandbox.polar.sh/checkout/test");
  });

  it("does not open the earlier account's checkout after an account switch", async () => {
    fixture.billing.mockResolvedValue({
      ...disabled,
      available: true,
      canCheckout: true,
      plans: [{ interval: "month", amountMinor: 1000, currency: "USD" }],
    });
    let resolveCheckout!: (value: { environment: "sandbox"; url: string }) => void;
    fixture.checkout.mockReturnValue(
      new Promise((resolve) => {
        resolveCheckout = resolve;
      }),
    );
    const client = new QueryClient();
    const screen = await render(panel(client));
    await choosePlan("Monthly");
    await expect.poll(() => fixture.checkout.mock.calls.length).toBe(1);
    fixture.status = signedIn("user_b");
    await screen.rerender(panel(client));
    resolveCheckout({ environment: "sandbox", url: "https://sandbox.polar.sh/checkout/old" });
    await expect.poll(() => client.isFetching()).toBe(0);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("shows an Alto subscriber their plan and opens the customer portal without sandbox claims", async () => {
    fixture.billing.mockResolvedValue({
      ...disabled,
      environment: "production",
      available: true,
      access: "granted",
      canManage: true,
    });
    fixture.portal.mockResolvedValue({
      environment: "production",
      url: "https://polar.sh/purchases/subscriptions",
    });
    await render(panel(new QueryClient()));
    await expect.element(page.getByText("Alto", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Sandbox", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Monthly/ })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    await expect.poll(() => fixture.open.mock.calls.length).toBe(1);
    expect(fixture.portal).toHaveBeenCalledOnce();
    expect(fixture.open).toHaveBeenCalledWith("https://polar.sh/purchases/subscriptions");
  });

  it.each([
    ["sandbox", "sandbox", "https://polar.sh/checkout/live"],
    ["sandbox", "production", "https://sandbox.polar.sh/checkout/test"],
    ["production", "sandbox", "https://polar.sh/checkout/live"],
    ["production", "production", "https://sandbox.polar.sh/checkout/test"],
  ] as const)(
    "refuses %s billing when a %s redirect points to %s",
    async (environment, redirectEnvironment, url) => {
      fixture.billing.mockResolvedValue({
        ...disabled,
        environment,
        available: true,
        canCheckout: true,
        plans: [{ interval: "month", amountMinor: 1000, currency: "USD" }],
      });
      fixture.checkout.mockResolvedValue({ environment: redirectEnvironment, url });
      await render(panel(new QueryClient()));
      await choosePlan("Monthly");
      await expect
        .element(
          page.getByText(
            environment === "sandbox"
              ? "Could not open test billing. Try again."
              : "Could not open billing. Try again.",
          ),
        )
        .toBeVisible();
      expect(fixture.open).not.toHaveBeenCalled();
    },
  );

  it("keeps the portal reachable for a former subscriber while offering the plans", async () => {
    fixture.billing.mockResolvedValue({
      ...disabled,
      environment: "production",
      available: true,
      canCheckout: true,
      canManage: true,
      plans: [{ interval: "month", amountMinor: 1000, currency: "USD" }],
    });
    fixture.portal.mockResolvedValue({
      environment: "production",
      url: "https://polar.sh/purchases/subscriptions",
    });
    await render(panel(new QueryClient()));
    await expect.element(page.getByRole("button", { name: /^Monthly/ })).toBeVisible();
    await page.getByRole("button", { name: "Manage billing", exact: true }).click();
    await expect.poll(() => fixture.open.mock.calls.length).toBe(1);
    expect(fixture.portal).toHaveBeenCalledOnce();
  });

  it("never leaves the section empty when no plan is on offer", async () => {
    fixture.billing.mockResolvedValue({ ...disabled, environment: "production", available: true });
    await render(panel(new QueryClient()));
    await expect.element(page.getByText("Free", { exact: true })).toBeVisible();
  });
});

describe("SynaraPlanLink", () => {
  function link(client: QueryClient) {
    return (
      <QueryClientProvider client={client}>
        <SynaraPlanLink />
      </QueryClientProvider>
    );
  }

  it("names the plan and opens it in Usage & limits", async () => {
    fixture.billing.mockResolvedValue({ ...disabled, environment: "production", available: true });
    await render(link(new QueryClient()));
    await page.getByRole("button", { name: "Free plan", exact: true }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "usage", target: "settings-synara-plan" },
    });
  });

  it("stays hidden while signed out", async () => {
    fixture.status = { state: "signed-out" };
    const screen = await render(link(new QueryClient()));
    expect(screen.container.textContent).toBe("");
    expect(fixture.billing).not.toHaveBeenCalled();
  });
});
