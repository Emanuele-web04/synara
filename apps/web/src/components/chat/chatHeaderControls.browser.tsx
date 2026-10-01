// FILE: chatHeaderControls.browser.tsx
// Purpose: Browser regressions for interactive versus static shared surface-tab chips, the
//          trailing close treatment used by open-thread tabs, and the surface-panel
//          toggle's accessible name — the needs-you dot is announced as "needs
//          attention", not only shown.
// Layer: Chat header controls test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsIcon } from "~/lib/icons";

import { SurfacePanelToggle, SurfaceTabChip } from "./chatHeaderControls";

describe("SurfaceTabChip selection", () => {
  afterEach(() => {
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
