// FILE: useSidebarThreadOrderHold.browser.tsx
// Purpose: Verifies the sidebar order holds while the pointer is over the list
//          and settles once the pointer leaves or the user types elsewhere.

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";
import { page } from "vitest/browser";

import type { SidebarThreadSortOrder } from "../appSettings";
import type { SidebarThreadSortInput } from "../components/Sidebar.logic";
import { useHeldSidebarThreadSortKeys, useIsPointerWithin } from "./useSidebarThreadOrderHold";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function mount(tagName: "div" | "textarea"): HTMLElement {
  const element = document.createElement(tagName);
  element.style.cssText = "display:block;width:100px;height:100px";
  document.body.append(element);
  cleanups.push(() => element.remove());
  return element;
}

function movePointer(target: Element, pointerType = "mouse") {
  target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType }));
}

describe("useIsPointerWithin", () => {
  it("keeps its hold when the stationary pointer target disappears", async () => {
    const list = mount("div");
    const row = list.appendChild(document.createElement("button"));
    row.textContent = "Transient row status";
    const outside = mount("div");
    outside.setAttribute("data-testid", "pointer-outside");
    const hook = await renderHook(() => useIsPointerWithin(list));
    try {
      await page.getByRole("button", { name: "Transient row status" }).hover();
      await expect.poll(() => hook.result.current).toBe(true);
      const { left, top } = list.getBoundingClientRect();
      row.remove();
      // Boundary events from a removed target have no destination node. The
      // pointer's actual hit target is still the containing list.
      document.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          clientX: left + 10,
          clientY: top + 10,
        }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(hook.result.current).toBe(true);
      await page.getByTestId("pointer-outside").hover();
      await expect.poll(() => hook.result.current).toBe(false);
      movePointer(list);
      await expect.poll(() => hook.result.current).toBe(true);
      document.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          clientX: window.innerWidth + 1,
          clientY: 10,
        }),
      );
      await expect.poll(() => hook.result.current).toBe(false);
      movePointer(list);
      await expect.poll(() => hook.result.current).toBe(true);
      // Chromium emits pointerleave on the document root for viewport exit.
      // This authoritative boundary must win even with last-inside coordinates.
      document.documentElement.dispatchEvent(
        new PointerEvent("pointerleave", {
          relatedTarget: null,
          clientX: left + 10,
          clientY: top + 10,
        }),
      );
      await expect.poll(() => hook.result.current).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  it("tracks mouse movement in and out, and releases when typing elsewhere", async () => {
    const list = mount("div");
    const row = list.appendChild(document.createElement("button"));
    const outside = mount("div");
    const composer = mount("textarea");
    const hook = await renderHook(() => useIsPointerWithin(list));
    try {
      expect(hook.result.current).toBe(false);

      movePointer(row);
      await expect.poll(() => hook.result.current).toBe(true);

      // Modifier keys for Cmd/Shift-click keep the hold.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Meta" }));
      await Promise.resolve();
      expect(hook.result.current).toBe(true);

      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      await expect.poll(() => hook.result.current).toBe(false);
      const rect = list.getBoundingClientRect();
      // A removed status node must not reactivate a hold released by typing.
      document.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          relatedTarget: null,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(hook.result.current).toBe(false);

      movePointer(row);
      await expect.poll(() => hook.result.current).toBe(true);

      movePointer(outside);
      await expect.poll(() => hook.result.current).toBe(false);

      movePointer(row, "touch");
      await Promise.resolve();
      expect(hook.result.current).toBe(false);
    } finally {
      await hook.unmount();
    }
  });
});

describe("useHeldSidebarThreadSortKeys", () => {
  const threadId = ThreadId.makeUnsafe("thread-unread");
  type TestThread = { id: ThreadId } & SidebarThreadSortInput;
  const unread: TestThread = {
    id: threadId,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed",
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
      assistantMessageId: null,
    },
  };
  const opened: TestThread = { ...unread, lastVisitedAt: "2026-03-09T12:00:00.000Z" };

  it("keeps captured keys while held and follows live keys otherwise", async () => {
    const hook = await renderHook(
      (props?: {
        threads: readonly TestThread[];
        hold: boolean;
        sortOrder: SidebarThreadSortOrder;
      }) =>
        useHeldSidebarThreadSortKeys({
          threads: props?.threads ?? [],
          sortOrder: props?.sortOrder ?? "updated_at",
          attentionFirst: true,
          hold: props?.hold ?? false,
        }),
      { initialProps: { threads: [unread], hold: false, sortOrder: "updated_at" } },
    );
    try {
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(1);

      await hook.rerender({ threads: [unread], hold: true, sortOrder: "updated_at" });
      await hook.rerender({ threads: [opened], hold: true, sortOrder: "updated_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(1);

      // A sort setting change applies immediately, even mid-hold.
      await hook.rerender({ threads: [opened], hold: true, sortOrder: "created_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(0);

      await hook.rerender({ threads: [unread], hold: true, sortOrder: "updated_at" });
      await hook.rerender({ threads: [opened], hold: false, sortOrder: "updated_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(0);
    } finally {
      await hook.unmount();
    }
  });
});
