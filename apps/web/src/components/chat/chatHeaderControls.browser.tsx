// FILE: chatHeaderControls.browser.tsx
// Purpose: Browser regressions for interactive versus static shared surface-tab chips,
//          plus the surface-panel toggle's accessible name — the needs-you dot is
//          announced as "needs attention", not only shown.
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
        ariaLabel="Group panel"
        tooltip="Group panel"
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Group panel, needs attention" }))
      .toBeInTheDocument();
  });

  it("keeps the plain label while no attention dot shows", async () => {
    await render(
      <SurfacePanelToggle
        state={{ open: false, onOpenChange: () => {} }}
        icon={SettingsIcon}
        ariaLabel="Group panel"
        tooltip="Group panel"
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Group panel", exact: true }))
      .toBeInTheDocument();
  });
});
