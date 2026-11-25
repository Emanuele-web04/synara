import "../../index.css";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProfileSettingsPanel } from "./ProfileSettingsPanel";
import { baseStats, tokenStats } from "../profile/profileTestFixtures";

const fixture = vi.hoisted(() => ({
  signOut: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/lib/accountBillingFlag", () => ({ ACCOUNT_BILLING_ENABLED: true }));
vi.mock("~/lib/serverReactQuery", () => ({
  serverProfileStatsQueryOptions: () => ({ queryKey: ["core"] }),
  serverProfileTokenStatsQueryOptions: () => ({ queryKey: ["tokens"] }),
}));
vi.mock("~/lib/accountReactQuery", () => ({
  accountUsageSummaryQueryOptions: () => ({ queryKey: ["usage"] }),
  accountBillingQueryOptions: () => ({ queryKey: ["billing"] }),
}));
vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({
    me: { id: "u1", name: "Tester", email: "tester@example.com", profile: null },
    status: { state: "signed-in", accountAuthority: "https://accounts.example.com" },
    profileSyncEnabled: false,
    signOut: { mutateAsync: fixture.signOut, isPending: false },
    deleteAccount: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey: string[] }) => ({
    data:
      options.queryKey[0] === "core"
        ? baseStats
        : options.queryKey[0] === "tokens"
          ? tokenStats
          : options.queryKey[0] === "billing"
            ? { available: true, access: "none" }
            : undefined,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("../profile/ShareDialog", () => ({ ShareDialog: () => null }));
vi.mock("../profile/EditProfileDialog", () => ({ EditProfileDialog: () => null }));

beforeEach(() => {
  fixture.signOut.mockReset().mockResolvedValue(undefined);
  fixture.navigate.mockReset();
});

describe("ProfileSettingsPanel Synara account card", () => {
  it("groups sign out, plan and delete account in one card", async () => {
    await render(<ProfileSettingsPanel />);
    await expect.element(page.getByText("Synara account", { exact: true })).toBeVisible();
    await expect.element(page.getByText("tester@example.com", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(fixture.signOut).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "See plans", exact: true }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "usage", target: "settings-synara-plan" },
    });

    await page.getByRole("button", { name: "Delete account…", exact: true }).click();
    await expect.element(page.getByText("Delete your Synara account?")).toBeVisible();
  });
});
