import "../../index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { findSplitNodeById, replacePaneInTree } from "../../splitView.logic";
import type { LeafPane, Pane, PaneId, SplitDirection } from "../../splitViewStore";
import { SplitPaneLayout } from "./SplitPaneLayout";

function leaf(id: string): LeafPane {
  return {
    kind: "leaf",
    id,
    threadId: null,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser",
    },
  };
}

function Harness({
  direction,
  onCommit,
  nested = false,
}: {
  direction: SplitDirection;
  nested?: boolean;
  onCommit: (id: PaneId, ratio: number) => void;
}) {
  const initial: Pane = {
    kind: "split",
    id: "root",
    direction,
    ratio: 0.5,
    first: leaf("first"),
    second: leaf("second"),
  };
  const [pane, setPane] = useState<Pane>(
    nested
      ? {
          kind: "split",
          id: "outer",
          direction: direction === "horizontal" ? "vertical" : "horizontal",
          ratio: 0.5,
          first: leaf("outside"),
          second: initial,
        }
      : initial,
  );
  return (
    <div style={{ display: "flex", width: 800, height: 600 }}>
      <SplitPaneLayout
        pane={pane}
        onSetRatio={(id, ratio) => {
          onCommit(id, ratio);
          const node = findSplitNodeById(pane, id)!;
          setPane(replacePaneInTree(pane, id, { ...node, ratio }));
        }}
        renderLeaf={({ leaf }) => <input aria-label={leaf.id} defaultValue="Unsent draft" />}
      />
    </div>
  );
}

function pointer(type: string, x: number, y: number, buttons = 1) {
  const target = document.elementFromPoint(x, y)!;
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    }),
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("split divider resizing", () => {
  it.each([
    { direction: "horizontal", nested: false },
    { direction: "vertical", nested: false },
    { direction: "horizontal", nested: true },
    { direction: "vertical", nested: true },
  ] as const)(
    "resizes both panes during a $direction drag (nested: $nested) and saves only on release",
    async ({ direction, nested }) => {
      const onCommit = vi.fn();
      await page.viewport(1000, 800);
      const screen = await render(
        <Harness direction={direction} nested={nested} onCommit={onCommit} />,
      );
      try {
        const input = screen.getByRole("textbox", { name: "first" }).element() as HTMLInputElement;
        input.value = "Keep this draft";
        const first = input.parentElement!;
        const second = screen.getByRole("textbox", { name: "second" }).element().parentElement!;
        const dividerNode = document.querySelector('[data-split-node-id="root"]')!;
        const container = dividerNode.parentElement!.getBoundingClientRect();
        const divider = dividerNode.getBoundingClientRect();
        pointer("pointerdown", divider.left + divider.width / 2, divider.top + divider.height / 2);
        const x = container.left + container.width * (direction === "horizontal" ? 0.65 : 0.5);
        const y = container.top + container.height * (direction === "vertical" ? 0.65 : 0.5);
        pointer("pointermove", x, y);
        await expect
          .poll(() =>
            direction === "horizontal"
              ? first.getBoundingClientRect().width
              : first.getBoundingClientRect().height,
          )
          .toBeCloseTo((direction === "horizontal" ? container.width : container.height) * 0.65, 0);
        expect(
          direction === "horizontal"
            ? second.getBoundingClientRect().width
            : second.getBoundingClientRect().height,
        ).toBeCloseTo((direction === "horizontal" ? container.width : container.height) * 0.35, 0);
        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByRole("textbox", { name: "first" }).element()).toBe(input);
        expect(input.value).toBe("Keep this draft");
        pointer("pointerup", x, y, 0);
        await expect.poll(() => onCommit.mock.calls).toEqual([["root", 0.65]]);
        await nextFrame();
        expect(document.querySelector("[data-panel-resize-overlay]")).toBeNull();
      } finally {
        window.dispatchEvent(new PointerEvent("pointerup"));
        window.dispatchEvent(new Event("blur"));
        await screen.unmount();
      }
    },
  );
});

describe("interrupted split resizing", () => {
  it.each(["pointercancel", "blur", "unmount"] as const)(
    "cleans up after %s without saving",
    async (interruption) => {
      await page.viewport(1000, 800);
      const onCommit = vi.fn();
      const screen = await render(<Harness direction="horizontal" onCommit={onCommit} />);
      const beforeCursor = document.body.style.cursor;
      const beforeUserSelect = document.body.style.userSelect;
      try {
        const first = screen.getByRole("textbox", { name: "first" }).element().parentElement!;
        const rect = first.parentElement!.getBoundingClientRect();
        pointer("pointerdown", rect.left + rect.width / 2, rect.top + rect.height / 2);
        const x = rect.left + rect.width * 0.95;
        const y = rect.top + rect.height / 2;
        pointer("pointermove", x, y);
        await expect
          .poll(() => first.getBoundingClientRect().width)
          .toBeCloseTo(rect.width * 0.75, 0);
        if (interruption === "unmount") await screen.unmount();
        else if (interruption === "blur") window.dispatchEvent(new Event("blur"));
        else pointer("pointercancel", x, y, 0);
        await nextFrame();
        expect(onCommit).not.toHaveBeenCalled();
        expect(document.querySelector("[data-panel-resize-overlay]")).toBeNull();
        expect(document.body.style.cursor).toBe(beforeCursor);
        expect(document.body.style.userSelect).toBe(beforeUserSelect);
        if (interruption !== "unmount")
          expect(first.getBoundingClientRect().width).toBeCloseTo(rect.width / 2, 0);
      } finally {
        window.dispatchEvent(new Event("blur"));
        if (interruption !== "unmount") await screen.unmount();
      }
    },
  );
});
