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
import {
  DEFAULT_THEME_STATE,
  buildThemeCssVariables,
  resolveThemePack,
  type ThemeVariant,
} from "~/theme/theme.logic";

import { AppRailUsage } from "./AppRailUsage";
import { ProviderUsageSettingsPanel } from "./settings/ProviderUsageSettingsPanel";

/** The app projects its theme pack into root variables on mount; the tile's tones need them. */
function applyTheme(variant: ThemeVariant) {
  const root = document.documentElement;
  root.classList.toggle("dark", variant === "dark");
  const build = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, variant), variant);
  for (const [name, value] of Object.entries(build.variables)) {
    root.style.setProperty(name, value);
  }
}

function channels(value: string): readonly [number, number, number] {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255] as const;
  const rgb = /^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (!rgb) throw new Error(`unreadable colour: ${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] as const;
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio, so a state's mark is measured rather than asserted. */
function contrast(left: string, right: string): number {
  const [light, dark] = [luminance(left), luminance(right)].toSorted((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** A rail token's colour, resolved in the tile's own context. */
function tileToken(tile: Element, name: string): string {
  const probe = document.createElement("span");
  probe.style.background = getComputedStyle(tile).getPropertyValue(name);
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

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
    <div data-sidebar-layout="rail">
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
    </div>
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
    applyTheme("light");
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
      .toBeChecked();
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
    const now = Date.now();
    const resetsAt = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    const { onOpenUsageSettings } = await renderAccounts([
      {
        provider: "opencode",
        updatedAt: new Date(now).toISOString(),
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

  it("draws every state by shape, with each mark measured against the track", async () => {
    const cases = [
      { remaining: 43, state: "normal" },
      { remaining: 18, state: "low" },
      { remaining: 0, state: "exhausted" },
    ] as const;
    const clientFor = (remaining: number) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, enabled: false } },
      });
      setProviderUsageQueryData(client, [
        {
          provider: "codex",
          updatedAt: "2026-10-02T12:00:00.000Z",
          status: "ok",
          source: "test",
          limits: [{ window: "Weekly", usedPercent: 100 - remaining }],
          usageLines: [],
        } satisfies ServerProviderUsageSnapshot,
      ]);
      client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
      return client;
    };
    await render(
      <div data-sidebar-layout="rail" className="flex items-start gap-4">
        {cases.map(({ remaining, state }) => (
          <div
            key={state}
            data-state={state}
            className="flex w-12 flex-col items-center gap-1 py-2"
          >
            <QueryClientProvider client={clientFor(remaining)}>
              <AppRailUsage onOpenUsageSettings={() => {}} />
            </QueryClientProvider>
          </div>
        ))}
      </div>,
    );
    const tileFor = (state: string) => {
      const tile = document.querySelector<HTMLElement>(
        `[data-state="${state}"] .app-rail-usage-tile`,
      );
      expect(tile).not.toBeNull();
      return tile!;
    };
    for (const theme of ["light", "dark"] as const) {
      applyTheme(theme);
      for (const { state } of cases) {
        const tile = tileFor(state);
        expect(tile).toHaveAttribute("data-usage-state", state);
        const track = tileToken(tile, "--rail-usage-well");
        const plate = tileToken(tile, "--rail-usage-plate");
        const ink = tileToken(tile, "--rail-usage-ink");
        const fill = tile.querySelector<HTMLElement>(".app-rail-usage-fill");
        // The metre's reach is readable: a 3:1 well, or, in dark, the 3:1 ring that draws it.
        if (theme === "light") {
          expect(contrast(track, plate)).toBeGreaterThanOrEqual(3);
        } else {
          expect(contrast(tileToken(tile, "--rail-usage-well-edge"), plate)).toBeGreaterThanOrEqual(
            3,
          );
        }
        expect(contrast(ink, track)).toBeGreaterThanOrEqual(3);
        expect(contrast(tileToken(tile, "--rail-usage-edge"), plate)).toBeGreaterThanOrEqual(3);
        if (state === "exhausted") {
          expect(fill).toBeNull();
        }
        if (state === "normal") {
          expect(fill?.style.height).toBe("43%");
          expect(getComputedStyle(fill!).backgroundImage).toContain("linear-gradient");
        }
        if (state === "low") {
          // The bar keeps its extent but loses its body to an outline, so it is not a hue shift.
          expect(fill?.style.height).toBe("18%");
          expect(getComputedStyle(fill!).backgroundImage).toBe("none");
          expect(getComputedStyle(fill!).boxShadow).toContain(ink);
        }
      }
      expect(document.querySelector('[data-state="exhausted"] button svg')).toHaveClass(
        "opacity-35",
      );
    }
  });

  it("lists every window, including an exhausted one, on the hover card", async () => {
    await renderUsage([
      { window: "Weekly", usedPercent: 0 },
      { window: "5h", usedPercent: 100 },
    ]);
    const button = page.getByRole("button", {
      name: "Codex usage: 5h 0% remaining, Weekly 100% remaining. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    const tile = button.element().querySelector(".app-rail-usage-tile")!;
    const frame = getComputedStyle(tile).boxShadow;
    expect(frame).toContain(tileToken(tile, "--destructive"));
    expect(frame).toContain("0px 0px 0px 1px inset");
    await userEvent.hover(button);
    expect(getComputedStyle(tile).boxShadow).toBe(frame);
    await expect.element(page.getByText("0% left", { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText("100% left", { exact: true }).last()).toBeVisible();
  });

  it("keeps an unavailable provider visible as an unfilled well, not an exhausted tile", async () => {
    await renderUsage([], "error");
    const button = page.getByRole("button", {
      name: "Codex usage: Unavailable. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    const tile = button.element().querySelector<HTMLElement>(".app-rail-usage-tile")!;
    expect(tile).toHaveAttribute("data-usage-state", "empty");
    expect(button.element().querySelector(".app-rail-usage-fill")).toBeNull();
    // No destructive frame: the empty well reads as "no reading", apart from a 0% tile.
    expect(getComputedStyle(tile).boxShadow).not.toContain(tileToken(tile, "--destructive"));
    expect(getComputedStyle(tile).boxShadow).toContain("0px 0px 0px 0.5px inset");
    expect(
      contrast(tileToken(tile, "--rail-usage-well"), tileToken(tile, "--rail-usage-plate")),
    ).toBeGreaterThanOrEqual(3);
  });
});
