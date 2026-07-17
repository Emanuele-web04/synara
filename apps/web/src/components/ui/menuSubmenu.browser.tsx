import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Menu, MenuItem, MenuPopup, MenuSub, MenuSubPopup, MenuSubTrigger } from "./menu";

function HoverSubmenuFixture() {
  const anchor = {
    getBoundingClientRect: () => new DOMRect(24, 24, 0, 0),
  };

  return (
    <Menu open>
      <MenuPopup anchor={anchor} align="start" side="bottom">
        <MenuItem>Primary action</MenuItem>
        <MenuSub keepOpenOnFocusOut>
          <MenuSubTrigger>Move to space</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>Void</MenuItem>
            <MenuItem>Work</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
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
});
