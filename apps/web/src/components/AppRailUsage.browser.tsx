import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerProviderUsageSnapshot,
  type ServerSettingsView,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const settings = vi.hoisted(() => ({
  codexHomePath: "",
  disabledProviders: [] as string[],
  railUsageProviders: ["codex"],
  railUsageInstanceIds: null as string[] | null,
  railUsageWindow: "both",
}));
const updateSettings = vi.hoisted(() => vi.fn());

vi.mock("~/appSettings", () => ({ useAppSettings: () => ({ settings, updateSettings }) }));

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { AppRailUsage } from "./AppRailUsage";
import { ProviderUsageSettingsPanel } from "./settings/ProviderUsageSettingsPanel";

async function renderAccounts(
  snapshots: readonly ServerProviderUsageSnapshot[],
  serverSettings: ServerSettingsView = DEFAULT_SERVER_SETTINGS_VIEW,
  showSettings = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  client.setQueryData(serverQueryKeys.allProviderUsage(), snapshots);
  client.setQueryData(serverQueryKeys.settings(), serverSettings);
  const onOpenUsageSettings = vi.fn();
  const content = () => (
    <QueryClientProvider client={client}>
      {showSettings ? (
        <div className="flex items-start gap-6 p-6">
          <div
            data-testid="usage-rail"
            className="flex w-12 shrink-0 flex-col items-center gap-1 rounded-lg bg-sidebar py-2"
          >
            <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
          </div>
          <div className="w-[520px] space-y-6">
            <ProviderUsageSettingsPanel />
          </div>
        </div>
      ) : (
        <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
      )}
    </QueryClientProvider>
  );
  const view = await render(content());
  return { client, onOpenUsageSettings, rerender: () => view.rerender(content()) };
}

async function renderUsage(
  limits: ServerProviderUsageSnapshot["limits"],
  status: ServerProviderUsageSnapshot["status"] = "ok",
) {
  const { onOpenUsageSettings } = await renderAccounts([
    {
      provider: "codex",
      updatedAt: "2026-10-02T12:00:00.000Z",
      status,
      source: "test",
      limits,
      usageLines: [],
    } satisfies ServerProviderUsageSnapshot,
  ]);
  return onOpenUsageSettings;
}

const claudeSettings: ServerSettingsView = {
  ...DEFAULT_SERVER_SETTINGS_VIEW,
  providerInstances: {
    claude_work: { driver: "claudeAgent", displayName: "Work", accentColor: "#2563eb" },
  },
};
const claudeSnapshots: readonly ServerProviderUsageSnapshot[] = [
  {
    provider: "claudeAgent",
    instanceId: "claude_work",
    updatedAt: "2026-10-02T12:00:00.000Z",
    status: "ok",
    source: "test",
    limits: [{ window: "Weekly", usedPercent: 80 }],
    usageLines: [],
  },
  {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    updatedAt: "2026-10-02T12:00:00.000Z",
    status: "ok",
    source: "test",
    limits: [{ window: "Weekly", usedPercent: 25 }],
    usageLines: [],
  },
];

describe("AppRailUsage", () => {
  beforeEach(() => {
    settings.railUsageWindow = "both";
    settings.disabledProviders = [];
    settings.railUsageProviders = ["codex"];
    settings.railUsageInstanceIds = null;
    updateSettings.mockReset().mockImplementation((patch) => Object.assign(settings, patch));
  });

  it("hides globally disabled selected accounts without erasing their saved selection", async () => {
    settings.disabledProviders = ["codex"];
    await renderUsage([{ window: "Weekly", usedPercent: 35 }]);
    expect(page.getByRole("button", { name: /^Codex usage:/ }).elements()).toHaveLength(0);
    expect(settings.railUsageProviders).toEqual(["codex"]);
  });

  it("selects two Claude accounts in Settings and shows each account's ring and hover card", async () => {
    settings.railUsageInstanceIds = [];
    const { rerender } = await renderAccounts(claudeSnapshots, claudeSettings, true);
    const personalSwitch = page.getByRole("switch", {
      name: "Show Claude · Default account usage at the bottom of the sidebar",
    });
    const workSwitch = page.getByRole("switch", {
      name: "Show Claude · Work usage at the bottom of the sidebar",
    });
    await personalSwitch.click();
    await rerender();
    await workSwitch.click();
    await rerender();
    expect(updateSettings).toHaveBeenLastCalledWith({
      railUsageInstanceIds: ["claudeAgent", "claude_work"],
    });
    await expect.element(personalSwitch).toBeChecked();
    await expect.element(workSwitch).toBeChecked();
    await expect
      .element(
        page.getByRole("switch", {
          name: "Show Codex usage at the bottom of the sidebar",
        }),
      )
      .toBeDisabled();

    const personal = page.getByRole("button", { name: /^Claude · Default account usage:/ });
    const work = page.getByRole("button", { name: /^Claude · Work usage:/ });
    await expect.element(personal).toBeVisible();
    await expect.element(work).toBeVisible();
    expect(
      personal
        .element()
        .querySelector("circle[stroke-dasharray]")
        ?.getAttribute("stroke-dasharray"),
    ).toBe("75 100");
    expect(
      work.element().querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray"),
    ).toBe("20 100");
    const accountDot = work.element().querySelector('[data-accent="#2563eb"]');
    expect(accountDot).not.toBeNull();
    const dotBounds = accountDot!.getBoundingClientRect();
    const glyphBounds = Array.from(work.element().querySelectorAll("svg"))
      .at(-1)!
      .getBoundingClientRect();
    // The account mark belongs beside the glyph, as in the model picker.
    expect(dotBounds.x + dotBounds.width / 2).toBeGreaterThan(
      glyphBounds.x + glyphBounds.width / 2,
    );
    expect(dotBounds.y + dotBounds.height / 2).toBeLessThan(glyphBounds.y + glyphBounds.height / 2);
    expect(dotBounds.right).toBeLessThanOrEqual(glyphBounds.right + 5);
    await userEvent.hover(work);
    await expect.element(page.getByText("Claude · Work", { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText("20% left", { exact: true }).last()).toBeVisible();
    await page
      .getByTestId("usage-rail")
      .screenshot({ path: "node_modules/.cache/multiple-claude-accounts.png" });

    await workSwitch.click();
    await rerender();
    await expect.element(work).not.toBeInTheDocument();
    await expect
      .element(
        page.getByRole("switch", {
          name: "Show Codex usage at the bottom of the sidebar",
        }),
      )
      .toBeEnabled();
  });

  it("never borrows a sibling's usage when the selected account has no matching snapshot", async () => {
    settings.railUsageInstanceIds = ["claudeAgent"];
    await renderAccounts(
      claudeSnapshots.filter((snapshot) => snapshot.instanceId === "claude_work"),
      claudeSettings,
    );
    await expect
      .element(page.getByRole("button", { name: /Claude.*usage:/ }))
      .not.toBeInTheDocument();
  });

  it("keeps the model picker's neutral marker for an additional account without an accent", async () => {
    settings.railUsageInstanceIds = ["claudeAgent", "claude_work"];
    await renderAccounts(claudeSnapshots, {
      ...claudeSettings,
      providerInstances: { claude_work: { driver: "claudeAgent", displayName: "Work" } },
    });
    const personal = page.getByRole("button", { name: /^Claude · Default account usage:/ });
    const work = page.getByRole("button", { name: /^Claude · Work usage:/ });
    expect(personal.element().querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(work.element().querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it("preserves a disabled account selection when another ring is changed", async () => {
    settings.railUsageInstanceIds = ["claude_work", "codex"];
    const { client, rerender } = await renderAccounts(
      claudeSnapshots,
      {
        ...claudeSettings,
        providerInstances: {
          claude_work: { driver: "claudeAgent", displayName: "Work", enabled: false },
        },
      },
      true,
    );
    await page
      .getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" })
      .click();
    await rerender();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work"]);
    await page
      .getByRole("switch", { name: "Show Claude usage at the bottom of the sidebar" })
      .click();
    await rerender();
    await page
      .getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" })
      .click();
    await rerender();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work", "claudeAgent", "codex"]);
    client.setQueryData(serverQueryKeys.settings(), claudeSettings);
    await rerender();
    await expect
      .element(
        page.getByRole("switch", { name: "Show Claude · Work usage at the bottom of the sidebar" }),
      )
      .toBeChecked();
    await expect.element(page.getByRole("button", { name: /^Claude · Work usage:/ })).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" }))
      .not.toBeChecked();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work", "claudeAgent", "codex"]);
  });

  it("hides disabled and removed accounts even when their usage remains cached", async () => {
    settings.railUsageInstanceIds = ["claude_work", "claude_removed"];
    await renderAccounts(
      [...claudeSnapshots, { ...claudeSnapshots[0]!, instanceId: "claude_removed" }],
      {
        ...claudeSettings,
        providerInstances: { claude_work: { driver: "claudeAgent", enabled: false } },
      },
    );
    await expect
      .element(page.getByRole("button", { name: /Claude.*usage:/ }))
      .not.toBeInTheDocument();
  });

  it("shows independent weekly and five-hour rings even when a model sublimit is tighter", async () => {
    const onOpenUsageSettings = await renderUsage([
      { window: "seven_day", usedPercent: 57, windowDurationMins: 10_080 },
      { window: "five_hour", usedPercent: 22, windowDurationMins: 300 },
      { window: "seven_day_sonnet", usedPercent: 96, windowDurationMins: 10_080 },
    ]);

    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(Array.from(fills, (circle) => circle.getAttribute("stroke-dasharray"))).toEqual([
      "43 100",
      "78 100",
    ]);
    expect(Number(fills[0]?.getAttribute("r"))).toBeGreaterThan(
      Number(fills[1]?.getAttribute("r")),
    );
    // Both rings colour by the same remaining-quota scale: 43% is fair, 78% is healthy.
    expect(fills[0]?.getAttribute("class")).toContain("stroke-yellow-500");
    expect(fills[1]?.getAttribute("class")).toContain("stroke-emerald-500");

    await userEvent.hover(button);
    await expect.element(page.getByText("Weekly · outer")).toBeVisible();
    await expect.element(page.getByText("5h · inner")).toBeVisible();
    await expect.element(page.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("78% left", { exact: true })).toBeVisible();
    await button.click();
    expect(onOpenUsageSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ["fiveHour", "85 100", "stroke-emerald-500"],
    ["weekly", "8 100", "stroke-red-500"],
  ])("draws a single ring for the %s setting", async (window, dasharray, strokeClassName) => {
    settings.railUsageWindow = window;
    await renderUsage([
      { window: "Weekly", usedPercent: 92 },
      { window: "5h", usedPercent: 15 },
    ]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe(dasharray);
    expect(fills[0]?.getAttribute("class")).toContain(strokeClassName);
  });

  it.each(["Weekly", "5h"])("shows only the reported %s ring", async (window) => {
    await renderUsage([{ window, usedPercent: 35 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("65 100");
  });

  it("keeps an empty track for an exhausted window without drawing a remaining arc", async () => {
    await renderUsage([
      { window: "Weekly", usedPercent: 0 },
      { window: "5h", usedPercent: 100 },
    ]);
    const button = page.getByRole("button", {
      name: "Codex usage: 5h 0% remaining, Weekly 100% remaining. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(3);
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("100 100");
  });

  it("preserves the single-ring fallback for providers with other limit windows", async () => {
    await renderUsage([{ window: "Monthly", usedPercent: 60 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("40 100");
  });

  it("keeps the unavailable provider visible without a quota arc", async () => {
    await renderUsage([], "error");
    const button = page.getByRole("button", {
      name: "Codex usage: Unavailable. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(1);
    expect(button.element().querySelectorAll("circle[stroke-dasharray]")).toHaveLength(0);
  });
});
