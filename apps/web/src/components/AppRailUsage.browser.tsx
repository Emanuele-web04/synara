import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerListProviderUsageInput,
  type ServerProviderUsageSnapshot,
  type ServerSettingsView,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const settings = vi.hoisted(() => ({
  codexHomePath: "",
  disabledProviders: [] as string[],
  railUsageProviders: ["codex"],
  railUsageInstanceIds: null as string[] | null,
}));
const updateSettings = vi.hoisted(() => vi.fn());

vi.mock("~/appSettings", () => ({ useAppSettings: () => ({ settings, updateSettings }) }));

import { serverQueryKeys, setProviderUsageQueryData } from "~/lib/serverReactQuery";

import { AppRailUsage } from "./AppRailUsage";
import { ProviderUsageSettingsPanel } from "./settings/ProviderUsageSettingsPanel";

async function renderAccounts(
  snapshots: readonly ServerProviderUsageSnapshot[] | undefined,
  serverSettings: ServerSettingsView = DEFAULT_SERVER_SETTINGS_VIEW,
  showSettings = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  if (snapshots) setProviderUsageQueryData(client, snapshots);
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
    settings.disabledProviders = [];
    settings.railUsageProviders = ["codex"];
    settings.railUsageInstanceIds = null;
    updateSettings.mockReset().mockImplementation((patch) => Object.assign(settings, patch));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows Codex quotas while selected Antigravity quotas are still loading", async () => {
    settings.railUsageInstanceIds = ["codex", "antigravity"];
    const codex: ServerProviderUsageSnapshot = {
      provider: "codex",
      updatedAt: "2026-10-02T12:00:00.000Z",
      source: "test",
      status: "ok",
      limits: [{ window: "Weekly", usedPercent: 20 }],
      usageLines: [],
    };
    const antigravity = { ...codex, provider: "antigravity" } as const;
    let releaseQuota!: (snapshot: ServerProviderUsageSnapshot) => void;
    const slow = new Promise<ServerProviderUsageSnapshot>((resolve) => {
      releaseQuota = resolve;
    });
    const listProviderUsage = vi.fn(async (input: ServerListProviderUsageInput) => {
      if (input.excludeProvider === "antigravity") return [codex];
      const quota = await slow;
      return input.provider === "antigravity" ? [quota] : [codex, quota];
    });
    vi.stubGlobal("nativeApi", { server: { listProviderUsage } });

    try {
      await renderAccounts(undefined);
      await expect.element(page.getByRole("button", { name: /^Codex usage:/ })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /^Antigravity usage:/ }))
        .not.toBeInTheDocument();
      releaseQuota(antigravity);
      await expect.element(page.getByRole("button", { name: /^Antigravity usage:/ })).toBeVisible();
    } finally {
      releaseQuota(antigravity);
    }
  });

  it("hides globally disabled selected accounts without erasing their saved selection", async () => {
    settings.disabledProviders = ["codex"];
    await renderUsage([{ window: "Weekly", usedPercent: 35 }]);
    expect(page.getByRole("button", { name: /^Codex usage:/ }).elements()).toHaveLength(0);
    expect(settings.railUsageProviders).toEqual(["codex"]);
  });

  it("selects two Claude accounts in Settings and shows each account's tile and hover card", async () => {
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
      personal.element().querySelector<HTMLElement>(".app-rail-usage-fill")?.style.height,
    ).toBe("75%");
    expect(work.element().querySelector<HTMLElement>(".app-rail-usage-fill")?.style.height).toBe(
      "20%",
    );
    expect(work.element().querySelector('[data-accent="#2563eb"]')).not.toBeNull();
    await userEvent.hover(work);
    await expect.element(page.getByText("Claude · Work", { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText("20% left", { exact: true }).last()).toBeVisible();

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
    expect(personal.element().querySelector('span.rounded-full[aria-hidden="true"]')).toBeNull();
    expect(work.element().querySelector('span.rounded-full[aria-hidden="true"]')).not.toBeNull();
  });

  it("preserves a disabled account selection when another tile is changed", async () => {
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

  it("fills one cell to the lowest quota and shows all three windows with resets on hover", async () => {
    settings.railUsageProviders = ["opencode"];
    const resetsAt = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const { onOpenUsageSettings } = await renderAccounts([
      {
        provider: "opencode",
        updatedAt: new Date().toISOString(),
        status: "ok",
        source: "test",
        limits: [
          { window: "5h", usedPercent: 22, resetsAt: resetsAt(1) },
          { window: "Weekly", usedPercent: 57, resetsAt: resetsAt(72) },
          { window: "Monthly", usedPercent: 88, resetsAt: resetsAt(288) },
        ],
        usageLines: [],
      },
    ]);

    const button = page.getByRole("button", { name: /^OpenCode usage:/ });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll(".app-rail-usage-fill")).toHaveLength(1);
    expect(button.element().querySelector<HTMLElement>(".app-rail-usage-fill")?.style.height).toBe(
      "12%",
    );
    expect(button.element().querySelector(".app-rail-usage-tile")).toHaveAttribute(
      "data-usage-state",
      "low",
    );

    await userEvent.hover(button);
    await expect.element(page.getByText("78% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("12% left", { exact: true })).toBeVisible();
    expect(page.getByText(/^Resets in /).elements()).toHaveLength(3);
    await button.click();
    expect(onOpenUsageSettings).toHaveBeenCalledOnce();
  });

  it.each([
    [21, "normal"],
    [20, "low"],
  ])("uses the correct tile color at %i%% remaining", async (remaining, state) => {
    await renderUsage([{ window: "Weekly", usedPercent: 100 - remaining }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelector(".app-rail-usage-tile")).toHaveAttribute(
      "data-usage-state",
      state,
    );
    expect(button.element().querySelector<HTMLElement>(".app-rail-usage-fill")?.style.height).toBe(
      `${remaining}%`,
    );
  });

  it("uses the tighter named model limit when present", async () => {
    await renderUsage([
      { window: "seven_day", usedPercent: 57, windowDurationMins: 10_080 },
      { window: "five_hour", usedPercent: 22, windowDurationMins: 300 },
      { window: "seven_day_sonnet", usedPercent: 96, windowDurationMins: 10_080 },
    ]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelector<HTMLElement>(".app-rail-usage-fill")?.style.height).toBe(
      "4%",
    );
  });

  it("shows a red outline and dims the glyph when any window is exhausted", async () => {
    await renderUsage([
      { window: "Weekly", usedPercent: 0 },
      { window: "5h", usedPercent: 100 },
    ]);
    const button = page.getByRole("button", {
      name: "Codex usage: 5h 0% remaining, Weekly 100% remaining. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    const tile = button.element().querySelector(".app-rail-usage-tile")!;
    expect(tile).toHaveAttribute("data-usage-state", "exhausted");
    expect(button.element().querySelector(".app-rail-usage-fill")).toBeNull();
    expect(button.element().querySelector("svg")).toHaveClass("opacity-35");
    const outline = getComputedStyle(tile).boxShadow;
    expect(outline).toContain("rgba(180, 35, 50, 0.52)");
    await userEvent.hover(button);
    expect(getComputedStyle(tile).boxShadow).toBe(outline);
  });

  it("keeps an unavailable provider visible with an empty neutral cell", async () => {
    await renderUsage([], "error");
    const button = page.getByRole("button", {
      name: "Codex usage: Unavailable. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelector(".app-rail-usage-tile")).toHaveAttribute(
      "data-usage-state",
      "empty",
    );
    expect(button.element().querySelector(".app-rail-usage-fill")).toBeNull();
  });
});
