import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResolvedKeybindingRule } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MAX_CHAT_FONT_SIZE_PX } from "~/appSettings";
import { getAppTypographyScale } from "~/lib/appTypography";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { TooltipProvider } from "~/components/ui/tooltip";

vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  getNavigatorPlatform: () => "Win32",
}));

import {
  KeyboardShortcutsSettingsPanel,
  KeyboardShortcutsResetButton,
} from "./KeyboardShortcutsSettingsPanel";

const binding: ResolvedKeybindingRule = {
  command: "sidebar.toggle",
  shortcut: {
    key: "pagedown",
    modKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    altKey: false,
  },
};

const typographyVariables = ["--app-font-size-ui", "--app-font-size-ui-sm"] as const;
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of typographyVariables) document.documentElement.style.removeProperty(name);
});

it("opens controller settings instead of editing or resetting a remote computer's shortcuts", async () => {
  const navigate = vi.fn();
  const frame = Object.assign(document.createElement("iframe"), {
    synaraWorkspace: { controller: { navigate } },
  });
  vi.spyOn(window, "frameElement", "get").mockReturnValue(frame);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.config(), {
    keybindings: [binding],
    defaultKeybindings: [],
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <KeyboardShortcutsResetButton />
        <KeyboardShortcutsSettingsPanel />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  try {
    await expect.poll(() => navigate.mock.calls).toEqual([["/settings?section=shortcuts"]]);
    await expect
      .element(page.getByRole("button", { name: "Reset all to defaults" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByPlaceholder("Search shortcuts")).not.toBeInTheDocument();
    // Back can reveal this persistent frame again after opening controller settings.
    await page.getByRole("button", { name: "Edit keybindings on this computer" }).click();
    expect(navigate).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it.each([360, 640])(
  "keeps a long shortcut and every action accessible at width %i and the largest UI font",
  async (width) => {
    const scale = getAppTypographyScale(MAX_CHAT_FONT_SIZE_PX);
    document.documentElement.style.setProperty("--app-font-size-ui", `${scale.uiPx}px`);
    document.documentElement.style.setProperty("--app-font-size-ui-sm", `${scale.uiSmPx}px`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(serverQueryKeys.config(), {
      keybindings: [binding],
      defaultKeybindings: [binding],
    });
    await render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <div style={{ width }}>
            <KeyboardShortcutsSettingsPanel />
          </div>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const change = page.getByRole("button", {
      name: /^Change the shortcut .* for Toggle sidebar$/,
    });
    const remove = page.getByRole("button", {
      name: /^Remove the shortcut .* from Toggle sidebar$/,
    });
    const add = page.getByRole("button", { name: "Add another shortcut for Toggle sidebar" });
    await expect.element(change).toBeVisible();
    const row = change.element().closest(".group\\/shortcut")!;
    const bounds = row.getBoundingClientRect();
    const controls = [row.querySelector("kbd")!, change.element(), add.element(), remove.element()];
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    // Browser hit-testing must reach the actual edit button, rather than an off-card control.
    await change.click();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Toggle sidebar");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await add.click();
    await expect
      .element(page.getByRole("dialog"))
      .toHaveTextContent("Choose the keys that run it.");
  },
);
