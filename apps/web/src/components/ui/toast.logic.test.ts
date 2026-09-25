import { assert, describe, it } from "vitest";
import {
  buildVisibleToastLayout,
  shouldHideCollapsedToastContent,
  shouldRunVisibleToastAutoDismiss,
} from "./toast.logic";

describe("shouldHideCollapsedToastContent", () => {
  it("keeps the front-most toast readable in a visible stack", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false);
  });

  it("hides non-front toasts until the stack is expanded", () => {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true);
  });
});

describe("shouldRunVisibleToastAutoDismiss", () => {
  it("also pauses for explicit, visibility, and window-focus gates", () => {
    assert.equal(
      shouldRunVisibleToastAutoDismiss({
        paused: true,
        documentVisible: true,
        windowFocused: true,
        toastFocused: false,
      }),
      false,
    );
    assert.equal(
      shouldRunVisibleToastAutoDismiss({
        paused: false,
        documentVisible: false,
        windowFocused: true,
        toastFocused: false,
      }),
      false,
    );
    assert.equal(
      shouldRunVisibleToastAutoDismiss({
        paused: false,
        documentVisible: true,
        windowFocused: false,
        toastFocused: false,
      }),
      false,
    );
  });
});

describe("buildVisibleToastLayout", () => {
  it("computes indices and offsets from the visible subset", () => {
    const visibleToasts = [
      { id: "a", height: 48 },
      { id: "b", height: 72 },
      { id: "c", height: 24 },
    ];

    const layout = buildVisibleToastLayout(visibleToasts);

    assert.equal(layout.frontmostHeight, 48);
    assert.deepEqual(
      layout.items.map(({ toast, visibleIndex, offsetY }) => ({
        id: toast.id,
        visibleIndex,
        offsetY,
      })),
      [
        { id: "a", visibleIndex: 0, offsetY: 0 },
        { id: "b", visibleIndex: 1, offsetY: 48 },
        { id: "c", visibleIndex: 2, offsetY: 120 },
      ],
    );
  });

  it("treats missing heights as zero", () => {
    const layout = buildVisibleToastLayout([
      { id: "a" },
      { id: "b", height: undefined },
      { id: "c", height: 30 },
    ]);

    assert.equal(layout.frontmostHeight, 0);
    assert.deepEqual(
      layout.items.map(({ toast, offsetY }) => ({
        id: toast.id,
        offsetY,
      })),
      [
        { id: "a", offsetY: 0 },
        { id: "b", offsetY: 0 },
        { id: "c", offsetY: 0 },
      ],
    );
  });
});
