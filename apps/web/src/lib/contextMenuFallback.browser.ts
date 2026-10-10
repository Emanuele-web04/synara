import "../index.css";

import { ThreadId, TurnId } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showContextMenuFallback } from "../contextMenuFallback";
import { getStopAgentProcessMenuItem, stopIdleRuntimeSessionFromClient } from "./threadRuntimeStop";

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

  it("manual idle agent action waits for cleanup after the menu is dismissed", async () => {
    const thread = { id: ThreadId.makeUnsafe("idle-owner"), session: { status: "ready" } };
    const stopItem = getStopAgentProcessMenuItem(thread);
    expect(stopItem).not.toBeNull();
    const before = showContextMenuFallback(ITEMS, { x: 24, y: 24 });
    await expect.element(page.getByText("Rename thread", { exact: true })).toBeVisible();
    await page
      .elementLocator(document.querySelector('[data-slot="context-menu-popup"]')!)
      .screenshot({ path: "../../../../output/playwright/idle-agent-stop-before.png" });
    await userEvent.keyboard("{Escape}");
    await before;

    let finishCleanup!: () => void;
    const stopIdleRuntimeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    let completed = false;
    const selected = showContextMenuFallback([ITEMS[0], stopItem!, ...ITEMS.slice(1)], {
      x: 24,
      y: 24,
    });
    const action = selected.then(async (itemId) => {
      if (itemId === "stop-agent-process") {
        await stopIdleRuntimeSessionFromClient({ stopIdleRuntimeSession }, thread);
        completed = true;
      }
    });
    await expect.element(page.getByText("Stop agent process", { exact: true })).toBeVisible();
    await page
      .elementLocator(document.querySelector('[data-slot="context-menu-popup"]')!)
      .screenshot({ path: "../../../../output/playwright/idle-agent-stop-after.png" });
    await page.getByText("Stop agent process", { exact: true }).click();
    await expect.poll(() => stopIdleRuntimeSession.mock.calls).toEqual([[{ threadId: thread.id }]]);
    expect(document.querySelector('[data-slot="context-menu-popup"]')).toBeNull();
    expect(completed).toBe(false);
    finishCleanup();
    await action;
    expect(completed).toBe(true);
  });

  it("manual idle agent action rejects a newly busy owner and hides shared child sessions", async () => {
    const thread = { id: ThreadId.makeUnsafe("idle-owner"), session: { status: "ready" } };
    const stopIdleRuntimeSession = vi.fn(async () => undefined);
    const menu = showContextMenuFallback([getStopAgentProcessMenuItem(thread)!], { x: 24, y: 24 });
    const currentThread = {
      ...thread,
      session: { status: "running", activeTurnId: TurnId.makeUnsafe("newly-started-turn") },
    };
    await page.getByText("Stop agent process", { exact: true }).click();
    expect(await menu).toBe("stop-agent-process");
    await expect(
      stopIdleRuntimeSessionFromClient({ stopIdleRuntimeSession }, currentThread),
    ).rejects.toThrow("Interrupt the current turn");
    const child = {
      ...thread,
      id: ThreadId.makeUnsafe("subagent:idle-owner:child"),
      parentThreadId: thread.id,
    };
    expect(getStopAgentProcessMenuItem(child)).toBeNull();
    await expect(
      stopIdleRuntimeSessionFromClient({ stopIdleRuntimeSession }, child),
    ).rejects.toThrow("Subagents share their parent");
    expect(stopIdleRuntimeSession).not.toHaveBeenCalled();
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
