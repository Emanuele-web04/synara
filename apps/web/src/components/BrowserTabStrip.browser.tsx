import "../index.css";

import type { BrowserTabState } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { BrowserTabStrip } from "./BrowserTabStrip";

const tabs: BrowserTabState[] = ["Active page", "Background page"].map((title, index) => ({
  id: `tab-${index}`,
  title,
  url: `https://example.test/${index}`,
  lastCommittedUrl: `https://example.test/${index}`,
  runtimeSurface: "native",
  status: "live",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  faviconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  lastError: null,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("browser tab mouse actions", () => {
  it.each(tabs)("closes $title with a middle click without selecting it", async (tab) => {
    const onCloseTab = vi.fn();
    const onSelectTab = vi.fn();
    const mounted = await render(
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={tabs[0]!.id}
        status={null}
        dragRegion
        onCloseTab={onCloseTab}
        onSelectTab={onSelectTab}
        onCreateTab={() => {}}
      />,
    );
    await page.getByRole("button", { name: tab.title }).click({ button: "middle" });
    expect(onCloseTab).toHaveBeenCalledExactlyOnceWith(tab.id);
    expect(onSelectTab).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("closes once from the favicon, close button, and tab padding without native middle-click defaults", async () => {
    const onCloseTab = vi.fn();
    const onSelectTab = vi.fn();
    const mounted = await render(
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={tabs[0]!.id}
        status={null}
        dragRegion
        onCloseTab={onCloseTab}
        onSelectTab={onSelectTab}
        onCreateTab={() => {}}
      />,
    );
    const tab = page.getByRole("button", { name: tabs[0]!.title }).element().parentElement!;
    const defaults: boolean[] = [];
    const recordDefault = (event: MouseEvent) => defaults.push(event.defaultPrevented);
    document.addEventListener("mousedown", recordDefault);
    try {
      await userEvent.click(tab.querySelector("img")!, { button: "middle" });
      await page.getByRole("button", { name: "Close tab" }).nth(0).click({ button: "middle" });
      await userEvent.click(tab, {
        button: "middle",
        position: { x: tab.getBoundingClientRect().width - 3, y: 14 },
      });
      expect(onCloseTab.mock.calls).toEqual([[tabs[0]!.id], [tabs[0]!.id], [tabs[0]!.id]]);
      expect(onSelectTab).not.toHaveBeenCalled();
      expect(defaults).toEqual([true, true, true]);
      expect(getComputedStyle(tab).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    } finally {
      document.removeEventListener("mousedown", recordDefault);
      await mounted.unmount();
    }
  });

  it("preserves left-click and keyboard actions and ignores other auxiliary clicks", async () => {
    const onCloseTab = vi.fn();
    const onSelectTab = vi.fn();
    const onCreateTab = vi.fn();
    const mounted = await render(
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={tabs[0]!.id}
        status={null}
        dragRegion
        onCloseTab={onCloseTab}
        onSelectTab={onSelectTab}
        onCreateTab={onCreateTab}
      />,
    );
    const title = page.getByRole("button", { name: tabs[1]!.title });
    await title.click({ button: "right" });
    await page.getByRole("button", { name: "New tab" }).click({ button: "middle" });
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(onSelectTab).not.toHaveBeenCalled();
    expect(onCreateTab).not.toHaveBeenCalled();
    await title.click();
    await userEvent.keyboard("{Enter}");
    expect(onSelectTab.mock.calls).toEqual([[tabs[1]!.id], [tabs[1]!.id]]);
    const close = page.getByRole("button", { name: "Close tab" }).nth(1);
    await close.click();
    await userEvent.keyboard("{Enter}");
    expect(onCloseTab.mock.calls).toEqual([[tabs[1]!.id], [tabs[1]!.id]]);
    await page.getByRole("button", { name: "New tab" }).click();
    expect(onCreateTab).toHaveBeenCalledOnce();
    await mounted.unmount();
  });
});
