import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type DesktopUpdateState } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const settings = vi.hoisted(() => ({
  codexHomePath: "",
  railUsageProviders: ["codex", "claudeAgent"],
  railUsageWindow: "both",
}));
vi.mock("~/appSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/appSettings")>()),
  useAppSettings: () => ({ settings }),
}));

import { buildRailItemOrder, RAIL_ORDERABLE_ITEM_IDS } from "~/appRail.logic";
import { getAppTypographyScale } from "~/lib/appTypography";
import { CircleQuestionIcon } from "~/lib/icons";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { resolveTasksSurfaceSlot } from "~/sidebarNavOrdering";
import {
  AppRail,
  appRailButtonClassName,
  railItemGlyphs,
  RAIL_MORE_GLYPHS,
  type AppRailItem,
} from "./AppRail";
import { AppRailUsage } from "./AppRailUsage";
import { DesktopUpdateRailButton } from "./DesktopUpdateRailButton";
import { SidebarIconButton } from "./SidebarIconButton";

const initial: DesktopUpdateState = {
  enabled: true,
  status: "downloading",
  currentVersion: "0.9.2",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.9.3",
  downloadedVersion: null,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "production",
  releaseUrl: null,
};

const previousFont = document.documentElement.style.getPropertyValue("--app-font-size-ui-2xs");
afterEach(() => {
  if (previousFont)
    document.documentElement.style.setProperty("--app-font-size-ui-2xs", previousFont);
  else document.documentElement.style.removeProperty("--app-font-size-ui-2xs");
});

function item(id: Parameters<typeof railItemGlyphs>[0]): AppRailItem {
  return {
    id,
    glyphs: railItemGlyphs(id),
    label: id === "settings" ? "Settings" : id,
    badge: null,
    active: false,
    onSelect: vi.fn(),
  };
}

function RailFixture({
  flavor,
  extraShortcuts = 0,
}: {
  flavor: "production" | "beta";
  extraShortcuts?: number;
}) {
  const [showUpdate, setShowUpdate] = useState(false);
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    queryClient.setQueryData(
      serverQueryKeys.allProviderUsage(),
      ["codex", "claudeAgent"].map((provider) => ({
        provider,
        updatedAt: new Date().toISOString(),
        source: "fixture",
        status: "ok",
        usageLines: [],
        limits: [
          { window: "5h", usedPercent: 25 },
          { window: "Weekly", usedPercent: 40 },
        ],
      })),
    );
    return queryClient;
  });
  const ids = buildRailItemOrder({
    order: resolveTasksSurfaceSlot([...RAIL_ORDERABLE_ITEM_IDS], flavor === "beta"),
    hidden: new Set(),
    activeItem: "home",
    studioAvailable: flavor === "beta",
    inboxAvailable: flavor === "beta",
  });
  // Stable has two fewer fixed destinations. Three Stable shortcuts and one
  // Beta shortcut exercise the same nearly-full real rail before an update.
  const shortcutCount = (flavor === "beta" ? 1 : 3) + extraShortcuts;
  return (
    <QueryClientProvider client={client}>
      <div style={{ position: "fixed", top: 44, bottom: 0, left: 0, display: "flex" }}>
        <AppRail
          items={ids.map(item)}
          shortcuts={Array.from({ length: shortcutCount }, (_, index) => ({
            ...item("spaces"),
            id: `space:${index}`,
            label: `Space ${index + 1}`,
          }))}
          moreSlot={
            <SidebarIconButton
              icon={RAIL_MORE_GLYPHS.idle}
              label="More"
              size="lg"
              className={appRailButtonClassName(false)}
            />
          }
          bottomItems={[item("settings")]}
          bottomSlot={
            <>
              <AppRailUsage onOpenUsageSettings={vi.fn()} />
              <SidebarIconButton
                icon={CircleQuestionIcon}
                label="Help"
                className={appRailButtonClassName(false)}
              />
              {showUpdate ? (
                <DesktopUpdateRailButton
                  state={{ ...initial, flavor }}
                  installing={false}
                  onClick={vi.fn()}
                />
              ) : null}
            </>
          }
        />
      </div>
      <button onClick={() => setShowUpdate(true)} style={{ position: "fixed", left: 100 }}>
        Offer update
      </button>
    </QueryClientProvider>
  );
}

describe("desktop update rail control", () => {
  it.each(["production", "beta"] as const)(
    "fits every percentage at supported UI sizes (%s)",
    async (flavor) => {
      const control = (percent: number) => (
        <AppRail
          items={[]}
          shortcuts={[]}
          bottomItems={[]}
          bottomSlot={
            <DesktopUpdateRailButton
              state={{ ...initial, flavor, downloadPercent: percent }}
              installing={false}
              onClick={vi.fn()}
            />
          }
        />
      );
      const screen = await render(control(100));
      try {
        for (const font of [11, 13, 18]) {
          document.documentElement.style.setProperty(
            "--app-font-size-ui-2xs",
            `${getAppTypographyScale(font).ui2XsPx}px`,
          );
          for (const percent of [0, 99, 100]) {
            await screen.rerender(control(percent));
            const button = page
              .getByRole("button", { name: `Preparing update (${percent}%)`, exact: true })
              .element();
            const label = button.querySelector("span span")!;
            const disc = label.parentElement!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            console.info("percentage bounds", {
              flavor,
              font,
              percent,
              textWidth: text.width,
              discWidth: disc.width,
            });
            expect(text.left).toBeGreaterThanOrEqual(disc.left - 0.5);
            expect(text.right).toBeLessThanOrEqual(disc.right + 0.5);
            const box = button.getBoundingClientRect();
            expect(disc.left).toBeGreaterThanOrEqual(box.left - 0.5);
            expect(disc.right).toBeLessThanOrEqual(box.right + 0.5);
            const rail = page
              .getByRole("navigation", { name: "Primary" })
              .element()
              .getBoundingClientRect();
            expect(box.left).toBeGreaterThanOrEqual(rail.left);
            expect(box.right).toBeLessThanOrEqual(rail.right);
            expect(getComputedStyle(label).fontSize).toBe(
              `${getAppTypographyScale(font).ui2XsPx}px`,
            );
            await expect
              .element(
                page.getByRole("button", { name: `Preparing update (${percent}%)`, exact: true }),
              )
              .toBeDisabled();
          }
        }
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["production", "beta"] as const)(
    "keeps bottom actions reachable when an update arrives at minimum height (%s)",
    async (flavor) => {
      await page.viewport(1280, 620);
      document.documentElement.style.setProperty(
        "--app-font-size-ui-2xs",
        `${getAppTypographyScale(18).ui2XsPx}px`,
      );
      const screen = await render(<RailFixture flavor={flavor} />);
      try {
        await expect.element(page.getByRole("button", { name: /^Codex usage:/ })).toBeVisible();
        await expect.element(page.getByRole("button", { name: /^Claude usage:/ })).toBeVisible();
        const settingsButton = page
          .getByRole("button", { name: "Settings", exact: true })
          .element();
        const before = settingsButton.getBoundingClientRect().bottom;
        expect(before).toBeLessThanOrEqual(620);
        await page.getByRole("button", { name: "Offer update", exact: true }).click();
        const after = settingsButton.getBoundingClientRect().bottom;
        console.info("minimum rail height", { flavor, before, after });
        expect(after).toBeLessThanOrEqual(620);
        const rail = page.getByRole("navigation", { name: "Primary" }).element();
        const bottomFirst = page
          .getByRole("button", { name: /^Codex usage:/ })
          .element()
          .getBoundingClientRect();
        const more = page.getByRole("button", { name: "More", exact: true }).element();
        more.focus();
        expect(document.activeElement).toBe(more);
        expect(more.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottomFirst.top);
        expect(rail.getBoundingClientRect().bottom).toBeLessThanOrEqual(620);
        const help = page
          .getByRole("button", { name: "Help", exact: true })
          .element()
          .getBoundingClientRect();
        const update = page
          .getByRole("button", { name: "Preparing update (100%)", exact: true })
          .element()
          .getBoundingClientRect();
        expect(help.bottom).toBeLessThanOrEqual(update.top);
        expect(update.bottom).toBeLessThanOrEqual(settingsButton.getBoundingClientRect().top);
        await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
        const home = page.getByRole("button", { name: "home", exact: true }).element();
        home.focus();
        expect(home.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          rail.getBoundingClientRect().top,
        );
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps the restart latch disabled and releases the control for a retry", async () => {
    const onClick = vi.fn();
    const ready = { ...initial, status: "downloaded" as const, downloadedVersion: "0.9.3" };
    const screen = await render(
      <DesktopUpdateRailButton state={ready} installing={false} onClick={onClick} />,
    );
    try {
      await page
        .getByRole("button", {
          name: "Update 0.9.3 is ready. Click to restart and install.",
          exact: true,
        })
        .click();
      expect(onClick).toHaveBeenCalledOnce();
      await screen.rerender(<DesktopUpdateRailButton state={ready} installing onClick={onClick} />);
      await expect
        .element(page.getByRole("button", { name: "Applying update…", exact: true }))
        .toBeDisabled();
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...ready, errorContext: "install" }}
          installing={false}
          onClick={onClick}
        />,
      );
      const retry = page.getByRole("button", {
        name: "Could not install update 0.9.3. Click to retry.",
        exact: true,
      });
      await expect.element(retry).toBeEnabled();
      retry.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(onClick).toHaveBeenCalledTimes(2);
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, status: "available" }}
          installing={false}
          onClick={onClick}
        />,
      );
      await expect
        .element(page.getByRole("button", { name: "Preparing update 0.9.3", exact: true }))
        .toBeDisabled();
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, status: "available", errorContext: "download" }}
          installing={false}
          onClick={onClick}
        />,
      );
      const downloadRetry = page.getByRole("button", {
        name: "Could not prepare update 0.9.3. Click to retry.",
        exact: true,
      });
      await downloadRetry.click();
      expect(onClick).toHaveBeenCalledTimes(3);
      await screen.rerender(
        <DesktopUpdateRailButton
          state={{ ...initial, downloadPercent: null }}
          installing={false}
          onClick={onClick}
        />,
      );
      const preparing = page.getByRole("button", { name: "Preparing update", exact: true });
      await expect.element(preparing).toBeDisabled();
      expect(preparing.element().querySelector("svg")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
