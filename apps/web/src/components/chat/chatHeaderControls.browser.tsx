import { waitForTransientPopups } from "../../lib/browserPopupCleanup";
// FILE: chatHeaderControls.browser.tsx
// Purpose: Browser regressions for interactive versus static shared surface-tab chips, the
//          trailing close treatment used by open-thread tabs,
//          the strip revealing its active tab, and the surface-panel toggle's accessible
//          name — the needs-you dot is announced as "needs attention", not only shown.
// Layer: Chat header controls test

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsIcon } from "~/lib/icons";

import { SurfacePanelToggle, SurfaceTabChip, SurfaceTabStrip } from "./chatHeaderControls";

describe("SurfaceTabChip selection", () => {
  afterEach(async () => {
    await waitForTransientPopups();
    document.body.innerHTML = "";
  });

  it("renders a static label when a single-pane host omits selection", async () => {
    await render(
      <SurfaceTabChip
        active
        icon={<span aria-hidden>PR</span>}
        label="PR #42"
        closeLabel="Close PR #42"
        onClose={vi.fn()}
      />,
    );

    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(page.getByRole("button", { name: "Close PR #42" })).toBeVisible();
    expect(document.body.textContent).toContain("PR #42");
    expect(document.querySelector("[aria-pressed]")).toBeNull();
  });

  it("keeps the selectable button for multi-pane hosts", async () => {
    const onSelect = vi.fn();
    await render(
      <SurfaceTabChip
        active
        icon={<span aria-hidden>PR</span>}
        label="PR #42"
        onSelect={onSelect}
      />,
    );

    const selectButton = document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(selectButton).not.toBeNull();
    selectButton?.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes a trailing-close tab from its X or a middle click without selecting it", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await render(
      <SurfaceTabChip
        closePlacement="trailing"
        selectionAria="current"
        icon={<span aria-hidden>AI</span>}
        label="Fix reconnect race"
        closeLabel="Close Fix reconnect race"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await page.getByRole("button", { name: "Close Fix reconnect race" }).click();
    const selectButton = page.getByRole("button", { name: "Fix reconnect race", exact: true });
    selectButton
      .element()
      .dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
    await selectButton.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("SurfaceTabStrip", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves vertical drift within a horizontal gesture alone, then accepts a fresh mouse wheel", async () => {
    await render(
      <SurfaceTabStrip style={{ width: 240 }} data-testid="strip">
        <div style={{ width: 1200, height: 40, flexShrink: 0 }}>Tabs</div>
      </SurfaceTabStrip>,
    );
    const strip = page.getByTestId("strip").element() as HTMLElement;

    // Native input exercises the browser's scrolling, rather than implementing it in a mock.
    await userEvent.wheel(strip, { delta: { x: 120, y: 0 } });
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(120));

    // A trackpad can briefly report no horizontal movement while the fingers stay down.
    // These samples must not become programmatic scrolls in the opposite direction.
    for (const deltaY of [-24, 16, -8]) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      strip.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
      expect(strip.scrollLeft).toBe(120);
    }

    await userEvent.wheel(strip, { delta: { x: -60, y: 0 } });
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(60));

    // After the gesture is quiet, an ordinary vertical mouse wheel still scrolls tabs.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await userEvent.wheel(strip, { delta: { x: 0, y: 40 } });
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(100));
  });

  it("scrolls a newly active tab hidden past the strip's edge into view", async () => {
    const tabs = ["one", "two", "three", "four", "five", "six"];
    const renderStrip = (activeKey: string) => (
      <div style={{ width: 240 }}>
        <SurfaceTabStrip activeKey={activeKey} data-testid="strip">
          {tabs.map((tab) => (
            <SurfaceTabChip
              key={tab}
              active={tab === activeKey}
              className="w-32 shrink-0"
              icon={<span aria-hidden>T</span>}
              label={`Tab ${tab}`}
              onSelect={vi.fn()}
            />
          ))}
        </SurfaceTabStrip>
      </div>
    );
    const screen = await render(renderStrip("one"));
    const strip = page.getByTestId("strip").element() as HTMLElement;
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);

    await screen.rerender(renderStrip("six"));

    await vi.waitFor(() => {
      const stripRect = strip.getBoundingClientRect();
      const tabRect = strip.querySelector("[data-surface-tab-active]")!.getBoundingClientRect();
      expect(tabRect.left).toBeGreaterThanOrEqual(stripRect.left - 1);
      expect(tabRect.right).toBeLessThanOrEqual(stripRect.right + 1);
    });
  });
});

describe("SurfacePanelToggle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the needs-attention state in the accessible name", async () => {
    await render(
      <SurfacePanelToggle
        state={{ open: false, onOpenChange: () => {}, attention: true }}
        icon={SettingsIcon}
        ariaLabel="Hub panel"
        tooltip="Hub panel"
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Hub panel, needs attention" }))
      .toBeInTheDocument();
  });

  it("keeps the plain label while no attention dot shows", async () => {
    await render(
      <SurfacePanelToggle
        state={{ open: false, onOpenChange: () => {} }}
        icon={SettingsIcon}
        ariaLabel="Hub panel"
        tooltip="Hub panel"
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Hub panel", exact: true }))
      .toBeInTheDocument();
  });
});
