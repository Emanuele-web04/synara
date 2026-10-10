import "../../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Menu, MenuItem, MenuPopupBase, MenuSub, MenuSubPopup, MenuSubTrigger } from "./menu";

function HoverSubmenuFixture() {
  const [open, setOpen] = useState(true);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const anchor = {
    getBoundingClientRect: () => new DOMRect(24, 24, 0, 0),
  };

  if (!open) return <p>Menu closed: {closedReason}</p>;

  return (
    <Menu
      keepOpenOnSubmenuInteraction
      open
      onOpenChange={(nextOpen, eventDetails) => {
        setClosedReason(eventDetails.reason);
        setOpen(nextOpen);
      }}
    >
      <MenuPopupBase anchor={anchor} align="start" side="bottom">
        <MenuItem>Primary action</MenuItem>
        <MenuSub keepOpenOnFocusOut>
          <MenuSubTrigger>Move to space</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>Void</MenuItem>
            <MenuItem>Work</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </MenuPopupBase>
    </Menu>
  );
}

describe("Menu submenu hover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays open while the pointer crosses from its trigger into the popup", async () => {
    const screen = await render(<HoverSubmenuFixture />);

    await page.getByText("Move to space", { exact: true }).hover();
    await expect.element(page.getByText("Void", { exact: true })).toBeVisible();

    await page.getByText("Void", { exact: true }).hover();
    await new Promise((resolve) => window.setTimeout(resolve, 220));

    await expect.element(page.getByText("Void", { exact: true })).toBeVisible();
    await screen.unmount();
  });

  it("still closes for an actual menu item selection", async () => {
    const screen = await render(<HoverSubmenuFixture />);

    await page.getByText("Primary action", { exact: true }).click();

    await expect.element(page.getByText("Menu closed: item-press", { exact: true })).toBeVisible();
    await screen.unmount();
  });
});
