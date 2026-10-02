import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { ServerCodexResetCredits } from "@synara/contracts";

import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";

const APP_SETTINGS_STORAGE_KEY = "synara:app-settings:v1";

const now = Date.now();
const rateLimits: ProviderRateLimit[] = [
  {
    provider: "codex",
    updatedAt: new Date(now).toISOString(),
    usedPercent: 86,
    windowDurationMins: 7 * 24 * 60,
    resetsAt: new Date(now + 21 * 60 * 60 * 1000).toISOString(),
  },
];
const resetCredits: ServerCodexResetCredits = {
  accountId: "panel-account",
  availableCount: 1,
  canUse: true,
  credits: [{ id: "reset-1", status: "available" }],
};
const usageLines: OpenUsageUsageLine[] = [
  { label: "24h", value: "942M tokens", subtitle: "191 recent sessions" },
];

const mount = (props: { rateLimits?: ProviderRateLimit[] } = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <div className="w-72 p-3">
        <ProviderUsagePanelContent
          provider="codex"
          rateLimits={props.rateLimits ?? rateLimits}
          usageLines={usageLines}
          resetCredits={resetCredits}
          showTitle={false}
        />
      </div>
    </QueryClientProvider>,
  );

beforeEach(() => {
  localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
});

describe("ProviderUsagePanelContent details", () => {
  it("keeps details collapsed behind the toggle and remembers the choice", async () => {
    await mount();
    const toggle = page.getByRole("button", { name: "Details" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    const tokens = () => page.getByText("942M tokens").element();
    // The collapsed region stays mounted but inert, so its contents are unreachable.
    expect(tokens().closest("[inert]")).not.toBeNull();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => tokens().closest("[inert]")).toBeNull();
    await expect
      .poll(() => JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toMatchObject({ usageDetailsDefaultOpen: true });
  });

  it("shows details directly when there are no limit rows", async () => {
    await mount({ rateLimits: [] });
    await expect.element(page.getByText("942M tokens")).toBeVisible();
    expect(page.getByRole("button", { name: "Details" }).elements()).toHaveLength(0);
  });
});
