import { assert, describe, it } from "vitest";
import {
  buildVisibleToastLayout,
  DEFAULT_TOAST_TIMEOUT_MS,
  shouldHideCollapsedToastContent,
  shouldRunVisibleToastAutoDismiss,
  shouldUseCompactToast,
} from "./toast.logic";

describe("DEFAULT_TOAST_TIMEOUT_MS", () => {
  it("auto-dismisses standard toasts after ten seconds", () => {
    assert.equal(DEFAULT_TOAST_TIMEOUT_MS, 10_000);
  });
});

describe("shouldUseCompactToast", () => {
  it("uses the compact layout for a plain toast", () => {
    assert.equal(shouldUseCompactToast({ data: {} }), true);
  });

  it("honors the contextual override even with copyable items", () => {
    assert.equal(
      shouldUseCompactToast({
        data: {
          compactContextual: true,
          copyItems: [{ label: "path", text: "/tmp" }],
        },
      }),
      true,
    );
  });

  it("renders expanded when the toast has copyable items or actions", () => {
    assert.equal(
      shouldUseCompactToast({
        data: { copyItems: [{ label: "path", text: "/tmp" }] },
      }),
      false,
    );
    assert.equal(shouldUseCompactToast({ data: { copyText: "x" } }), false);
    assert.equal(shouldUseCompactToast({ actionProps: {} }), false);
    assert.equal(shouldUseCompactToast({ data: { secondaryActionProps: {} } }), false);
  });

  it("keeps an empty copy item list compact", () => {
    assert.equal(shouldUseCompactToast({ data: { copyItems: [] } }), true);
  });
});

describe("shouldHideCollapsedToastContent", () => {
  it("keeps a single visible toast readable", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 1), false);
  });

  it("keeps the front-most toast readable in a visible stack", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false);
  });

  it("hides non-front toasts until the stack is expanded", () => {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true);
  });
});

describe("shouldRunVisibleToastAutoDismiss", () => {
  it("runs only while the toast is visible, the window is focused, and the toast has no focus", () => {
    assert.equal(
      shouldRunVisibleToastAutoDismiss({
        paused: false,
        documentVisible: true,
        windowFocused: true,
        toastFocused: false,
      }),
      true,
    );
  });

  it("pauses while keyboard focus is inside the toast", () => {
    assert.equal(
      shouldRunVisibleToastAutoDismiss({
        paused: false,
        documentVisible: true,
        windowFocused: true,
        toastFocused: true,
      }),
      false,
    );
  });

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
