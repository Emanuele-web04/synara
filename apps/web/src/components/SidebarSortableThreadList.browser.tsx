// FILE: SidebarSortableThreadList.browser.tsx
// Purpose: Browser coverage for keyboard-accessible conversation reordering and cancellation.
// Layer: Sidebar UI browser test

import "../index.css";

import { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  SidebarSortableThreadItem,
  SidebarSortableThreadList,
  SidebarThreadReorderHandle,
} from "./SidebarSortableThreadList";

const INITIAL_ITEMS = [
  { id: ThreadId.makeUnsafe("thread-a"), title: "Alpha" },
  { id: ThreadId.makeUnsafe("thread-b"), title: "Bravo" },
  { id: ThreadId.makeUnsafe("thread-c"), title: "Charlie" },
];

function SortableHarness() {
  const [items, setItems] = useState(INITIAL_ITEMS);
  return (
    <SidebarSortableThreadList
      items={items}
      onMove={({ activeThreadId, overThreadId }) => {
        setItems((current) => {
          const next = [...current];
          const activeIndex = next.findIndex((item) => item.id === activeThreadId);
          const overIndex = next.findIndex((item) => item.id === overThreadId);
          const [active] = next.splice(activeIndex, 1);
          if (active) next.splice(overIndex, 0, active);
          return next;
        });
      }}
    >
      <ol aria-label="Conversations">
        {items.map((item) => (
          <SidebarSortableThreadItem key={item.id} threadId={item.id}>
            {(sortable) => (
              <li
                ref={sortable.setNodeRef}
                style={sortable.style}
                className={sortable.sortableClassName}
              >
                <span>{item.title}</span>
                <SidebarThreadReorderHandle
                  threadId={item.id}
                  title={item.title}
                  manualOrder
                  sortable={sortable}
                />
              </li>
            )}
          </SidebarSortableThreadItem>
        ))}
      </ol>
    </SidebarSortableThreadList>
  );
}

function pressFocusedKey(code: string, key = code) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code, key }),
  );
}

async function dragHandleTo(sourceId: string, targetId: string) {
  const source = document.querySelector<HTMLElement>(
    `[data-thread-reorder-handle="${sourceId}"]`,
  );
  const target = document.querySelector<HTMLElement>(
    `[data-thread-reorder-handle="${targetId}"]`,
  );
  if (!source || !target) throw new Error("Expected sortable handles to be rendered");
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
  } as const;
  source.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...init,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
    }),
  );
  document.dispatchEvent(
    new PointerEvent("pointermove", {
      ...init,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2 + 8,
    }),
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  document.dispatchEvent(
    new PointerEvent("pointermove", {
      ...init,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    }),
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  document.dispatchEvent(
    new PointerEvent("pointerup", {
      ...init,
      buttons: 0,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    }),
  );
}

describe("SidebarSortableThreadList", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reorders a conversation using the keyboard", async () => {
    await render(<SortableHarness />);
    const handle = page.getByRole("button", { name: "Reorder Alpha" });
    await userEvent.click(handle);
    await expect.element(handle).toHaveFocus();
    pressFocusedKey("Space", " ");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.body.textContent).toContain("Alpha, position 1 of 3 picked up.");
    pressFocusedKey("ArrowDown");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    pressFocusedKey("Space", " ");
    await expect.element(page.getByRole("list", { name: "Conversations" })).toHaveTextContent(
      "BravoAlphaCharlie",
    );
  });

  it("reorders a conversation using the pointer handle", async () => {
    await render(<SortableHarness />);
    await dragHandleTo("thread-a", "thread-c");
    await expect.element(page.getByRole("list", { name: "Conversations" })).toHaveTextContent(
      "BravoCharlieAlpha",
    );
  });

  it("keeps the order when a keyboard drag is cancelled", async () => {
    await render(<SortableHarness />);
    await userEvent.click(page.getByRole("button", { name: "Reorder Alpha" }));
    pressFocusedKey("Space", " ");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    pressFocusedKey("ArrowDown");
    pressFocusedKey("Escape");
    await expect.element(page.getByRole("list", { name: "Conversations" })).toHaveTextContent(
      "AlphaBravoCharlie",
    );
  });
});
