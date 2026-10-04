import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { showContextMenuFallback } from "../contextMenuFallback";

const ITEMS = [
  { id: "rename", label: "Rename thread" },
  {
    id: "copy",
    label: "Copy",
    children: [
      { id: "copy-path", label: "Path" },
      { id: "copy-thread-id", label: "Thread ID" },
    ],
  },
  { id: "archive", label: "Archive" },
] as const;

describe("showContextMenuFallback submenus", () => {
  // Park the pointer away from where the menu opens so a leftover hover from the
  // previous test cannot move the keyboard highlight.
  beforeEach(async () => {
    document.body.style.minHeight = "100vh";
    await userEvent.hover(document.body, { position: { x: 600, y: 500 } });
  });

  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.innerHTML = "";
  });

  it("opens a submenu on hover and resolves the picked child", async () => {
    const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

    await expect.element(page.getByText("Copy", { exact: true })).toBeVisible();
    expect(page.getByText("Thread ID", { exact: true }).query()).toBeNull();

    await page.getByText("Copy", { exact: true }).hover();
    await page.getByText("Thread ID", { exact: true }).click();

    await expect(result).resolves.toBe("copy-thread-id");
    expect(document.querySelector('[data-slot^="context-menu"]')).toBeNull();
  });

  it("closes the submenu when the pointer moves to a sibling row", async () => {
    const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

    await page.getByText("Copy", { exact: true }).hover();
    await expect.element(page.getByText("Path", { exact: true })).toBeVisible();
    await page.getByText("Archive", { exact: true }).hover();

    await expect.poll(() => page.getByText("Path", { exact: true }).query()).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect(result).resolves.toBeNull();
  });

  it("keeps the submenu open when the pointer crosses a sibling row on its way in", async () => {
    const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

    await page.getByText("Copy", { exact: true }).hover();
    await page.getByText("Archive", { exact: true }).hover();
    await page.getByText("Thread ID", { exact: true }).hover();
    // Longer than the switch delay: the brush over "Archive" must not close it late.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    await page.getByText("Thread ID", { exact: true }).click();

    await expect(result).resolves.toBe("copy-thread-id");
  });

  it("drives a submenu from the keyboard", async () => {
    const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

    // Down to "Copy", into its submenu, down to "Thread ID", select.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}{ArrowDown}{Enter}");

    await expect(result).resolves.toBe("copy-thread-id");
  });

  it.each([
    { hoveredRow: "Archive", keys: ["Enter"] },
    { hoveredRow: "Copy", keys: ["ArrowDown", "Enter"] },
  ])(
    "keeps keyboard selection in the hovered parent menu ($hoveredRow)",
    async ({ hoveredRow, keys }) => {
      const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

      if (hoveredRow !== "Copy") await page.getByText("Copy", { exact: true }).hover();
      const row = page.getByText(hoveredRow, { exact: true });
      let hadOpenSubmenu = false;
      row
        .element()
        .closest("button")!
        .addEventListener(
          "mouseenter",
          () => {
            // Press in the hover event's turn, before the diagonal-hover grace period
            // can expire. The flyout is visible but the root row owns keyboard focus.
            hadOpenSubmenu = page.getByText("Path", { exact: true }).query() !== null;
            for (const key of keys) document.dispatchEvent(new KeyboardEvent("keydown", { key }));
          },
          { once: true },
        );
      await row.hover();

      expect(hadOpenSubmenu).toBe(true);
      expect(document.querySelector('[data-slot^="context-menu"]')).toBeNull();
      await expect(result).resolves.toBe("archive");
    },
  );

  it("returns to the parent menu on ArrowLeft without dismissing it", async () => {
    const result = showContextMenuFallback(ITEMS, { x: 24, y: 24 });

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}{ArrowLeft}");
    expect(page.getByText("Path", { exact: true }).query()).toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    await expect(result).resolves.toBe("archive");
  });
});
