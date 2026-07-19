import { assert, describe, it } from "vitest";
import {
  buildVisibleToastLayout,
  isOpenThreadToastShortcut,
  shouldHideCollapsedToastContent,
} from "./toast.logic";

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

describe("isOpenThreadToastShortcut", () => {
  type ShortcutEvent = Parameters<typeof isOpenThreadToastShortcut>[0];
  const event = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
    altKey: true,
    code: "KeyL",
    ctrlKey: false,
    key: "l",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  });

  it("matches Option+L by physical key when Option changes the typed character", () => {
    assert.isTrue(isOpenThreadToastShortcut(event({ key: "¬" })));
  });

  it("matches Alt+L without a physical key code", () => {
    assert.isTrue(isOpenThreadToastShortcut(event({ code: "" })));
  });

  it("rejects repeats, other keys, and additional modifiers", () => {
    assert.isFalse(isOpenThreadToastShortcut(event({ repeat: true })));
    assert.isFalse(isOpenThreadToastShortcut(event({ altKey: false })));
    assert.isFalse(isOpenThreadToastShortcut(event({ code: "KeyK", key: "k" })));
    assert.isFalse(isOpenThreadToastShortcut(event({ ctrlKey: true })));
    assert.isFalse(isOpenThreadToastShortcut(event({ metaKey: true })));
    assert.isFalse(isOpenThreadToastShortcut(event({ shiftKey: true })));
  });
});
