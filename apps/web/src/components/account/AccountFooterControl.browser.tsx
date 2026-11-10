import "../../index.css";

import type { AccountMe } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  me: null as AccountMe | null,
  navigate: vi.fn(),
  openExternalLink: vi.fn(),
}));

vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({ me: fixture.me }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
  useRouterState: () => false,
}));
vi.mock("~/lib/linkChips", () => ({ openExternalLink: fixture.openExternalLink }));

import { AccountFooterControl } from "./AccountFooterControl";
import { publicProfileUrl } from "~/lib/accountLogic";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.me = {
    id: "user_ada",
    name: "Ada Lovelace",
    email: "ada@example.test",
    organization: { id: "org_ada", name: "Personal" },
    profile: {
      handle: "ada",
      displayName: "Ada Lovelace",
      avatarColor: "#5A8DEE",
      public: true,
    },
  };
});

async function openAccountMenu() {
  await render(<AccountFooterControl />);
  await page.getByRole("button", { name: "Account: Ada Lovelace" }).click();
}

describe("account public-profile entry", () => {
  it.each([
    { name: "lapsed Alto", published: true, available: false },
    { name: "private profile", published: false, available: false },
    { name: "missing availability from an older server", published: true, available: undefined },
    {
      name: "private profile despite a stale availability flag",
      published: false,
      available: true,
    },
  ])("opens in-app profile and Alto settings for $name", async ({ published, available }) => {
    fixture.me = {
      ...fixture.me!,
      publicProfileAvailable: available,
      profile: { ...fixture.me!.profile!, public: published },
    };
    await openAccountMenu();

    await expect
      .element(page.getByRole("menuitem", { name: "View public profile", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "Make your profile public", exact: true }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "profile" },
    });
    expect(fixture.openExternalLink).not.toHaveBeenCalled();
  });

  it("opens the online profile only when publication and availability are confirmed", async () => {
    fixture.me = { ...fixture.me!, publicProfileAvailable: true };
    await openAccountMenu();

    await expect
      .element(page.getByRole("menuitem", { name: "Make your profile public", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "View public profile", exact: true }).click();
    expect(fixture.openExternalLink).toHaveBeenCalledWith(publicProfileUrl("ada"));
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});
