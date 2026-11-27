import { describe, expect, it } from "vitest";
import {
  CANVAS_SHORTCUT_GUIDE,
  canvasKeyOf,
  canvasKeyOfPress,
  canvasMenuShortcut,
  canvasShortcutLabelFor,
  matchCanvasShortcut,
  type CanvasShortcut,
  type CanvasShortcutContext,
} from "./canvasShortcuts";

const context: CanvasShortcutContext = {
  selection: 1,
  singleLayer: true,
  readOnly: false,
  spaceHeld: false,
};
const press = (
  key: string,
  init: Partial<Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {},
  mac = true,
) =>
  canvasKeyOf(
    {
      key,
      code: init.code ?? "",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...init,
    },
    mac,
  );

describe("matchCanvasShortcut", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere as the command key", () => {
    expect(matchCanvasShortcut(press("z", { metaKey: true }), context)).toEqual({ id: "undo" });
    expect(matchCanvasShortcut(press("z", { ctrlKey: true }), context)).toBeNull();
    expect(matchCanvasShortcut(press("z", { ctrlKey: true }, false), context)).toEqual({
      id: "undo",
    });
    expect(matchCanvasShortcut(press("Z", { metaKey: true, shiftKey: true }), context)).toEqual({
      id: "redo",
    });
  });

  it("falls through to the next rule when a rule needs a selection", () => {
    const none = { ...context, selection: 0, singleLayer: false };
    expect(matchCanvasShortcut(press("c", { metaKey: true, shiftKey: true }), context)).toEqual({
      id: "copy-png",
    });
    expect(matchCanvasShortcut(press("c", { metaKey: true, shiftKey: true }), none)).toEqual({
      id: "copy",
    });
    expect(matchCanvasShortcut(press("ArrowLeft"), none)).toBeNull();
    expect(matchCanvasShortcut(press("Tab"), { ...context, singleLayer: false })).toBeNull();
  });

  it("nudges 1 px, 8 with Shift, and arranges with the bracket keys", () => {
    expect(matchCanvasShortcut(press("ArrowRight"), context)).toEqual({
      id: "nudge",
      dx: 1,
      dy: 0,
    });
    expect(matchCanvasShortcut(press("ArrowUp", { shiftKey: true }), context)).toEqual({
      id: "nudge",
      dx: 0,
      dy: -8,
    });
    expect(matchCanvasShortcut(press("[", { code: "BracketLeft" }), context)).toEqual({
      id: "arrange",
      mode: "back",
    });
    expect(
      matchCanvasShortcut(press("]", { code: "BracketRight", metaKey: true }), context),
    ).toEqual({ id: "arrange", mode: "forward" });
  });

  it("matches ⇧0/⇧1/⇧2 by key code, since ⇧0 types a parenthesis", () => {
    expect(matchCanvasShortcut(press(")", { code: "Digit0", shiftKey: true }), context)).toEqual({
      id: "zoom-100",
    });
    expect(matchCanvasShortcut(press("@", { code: "Digit2", shiftKey: true }), context)).toEqual({
      id: "fit-selection",
    });
  });

  it("orders ⇧A (flex) before the A tool, and keeps creation tools out of read-only", () => {
    expect(matchCanvasShortcut(press("A", { shiftKey: true }), context)).toEqual({
      id: "add-flex",
    });
    expect(matchCanvasShortcut(press("a"), context)).toEqual({ id: "tool", tool: "frame" });
    const readOnly = { ...context, readOnly: true };
    expect(matchCanvasShortcut(press("A", { shiftKey: true }), readOnly)).toBeNull();
    expect(matchCanvasShortcut(press("r"), readOnly)).toBeNull();
    expect(matchCanvasShortcut(press("h"), readOnly)).toEqual({ id: "tool", tool: "hand" });
  });

  it("selects the parent with ⇧Enter or backslash, deselects with Ctrl+Esc, holds Space once", () => {
    expect(matchCanvasShortcut(press("Enter", { shiftKey: true }), context)).toEqual({
      id: "select-parent",
    });
    expect(matchCanvasShortcut(press("\\"), context)).toEqual({ id: "select-parent" });
    expect(matchCanvasShortcut(press("Enter"), context)).toEqual({ id: "enter" });
    expect(matchCanvasShortcut(press("Escape", { ctrlKey: true }), context)).toEqual({
      id: "escape",
      deselect: true,
    });
    expect(matchCanvasShortcut(press(" "), context)).toEqual({ id: "hold-space" });
    expect(matchCanvasShortcut(press(" "), { ...context, spaceHeld: true })).toBeNull();
  });

  it("resolves keys bound twice as documented", () => {
    const none = { ...context, selection: 0, singleLayer: false };
    const match = (key: string, init: Parameters<typeof press>[1] = {}, on = context) =>
      matchCanvasShortcut(press(key, init), on);
    // Digits: opacity with a selection, zoom without one.
    expect(match("5", { code: "Digit5" })).toEqual({ id: "opacity-digit", digit: 5 });
    expect(match("1", { code: "Digit1" }, none)).toEqual({ id: "fit-all" });
    expect(match("0", { code: "Digit0" }, none)).toEqual({ id: "zoom-100" });
    expect(match("2", { code: "Digit2" }, none)).toEqual({ id: "fit-selection" });
    expect(match("7", { code: "Digit7" }, none)).toBeNull();
    expect(match("0", { code: "Digit0", metaKey: true })).toEqual({ id: "zoom-100" });
    expect(match("+", { code: "Equal", shiftKey: true }, none)).toEqual({
      id: "zoom",
      factor: 1.25,
    });
    expect(match("-", { code: "Minus" }, none)).toEqual({ id: "zoom", factor: 0.8 });
    expect(match("PageDown", { code: "PageDown" })).toEqual({ id: "page", step: 1 });
    expect(match("PageUp", { code: "PageUp" })).toEqual({ id: "page", step: -1 });
    expect(match("n", { code: "KeyN" })).toEqual({ id: "frame-step", step: 1 });
    expect(match("N", { code: "KeyN", shiftKey: true })).toEqual({ id: "frame-step", step: -1 });
    expect(match("D", { code: "KeyD", metaKey: true, shiftKey: true })).toEqual({
      id: "dashboard",
    });
    expect(match("d", { code: "KeyD", metaKey: true })).toEqual({ id: "duplicate" });
    expect(match(".", { code: "Period" })).toEqual({ id: "toggle-ui" });
    expect(match("\\", { code: "Backslash", metaKey: true })).toEqual({ id: "toggle-ui" });
    expect(match("¡", { code: "Digit1", altKey: true })).toEqual({ id: "show-layers" });
    expect(match("¬", { code: "KeyL", altKey: true })).toEqual({ id: "collapse-layers" });
    expect(match("r", { code: "KeyR", metaKey: true })).toEqual({ id: "rename" });
    expect(match("V", { code: "KeyV", metaKey: true, shiftKey: true })).toEqual({
      id: "paste-special",
      mode: "on-top",
    });
    expect(match("R", { code: "KeyR", metaKey: true, shiftKey: true })).toEqual({
      id: "paste-special",
      mode: "replace",
    });
    expect(match("L", { code: "KeyL", metaKey: true, altKey: true, shiftKey: true })).toEqual({
      id: "unlock-all",
    });
    expect(match("L", { code: "KeyL", metaKey: true, shiftKey: true })).toEqual({
      id: "toggle-locked",
    });
    expect(match("Á", { code: "KeyA", altKey: true, shiftKey: true })).toEqual({
      id: "remove-flex",
    });
    expect(match("ç", { code: "KeyC", altKey: true })).toEqual({ id: "clip-content" });
    expect(match("C", { code: "KeyC", shiftKey: true }, none)).toEqual({ id: "toggle-comments" });
    expect(match("y", { code: "KeyY" })).toEqual({ id: "tool", tool: "comment" });
    // Text keys: align, then size, weight, line height and letter spacing on . and ,.
    expect(match("¬", { code: "KeyL", metaKey: true, altKey: true })).toEqual({
      id: "text-align",
      align: "left",
    });
    expect(match("†", { code: "KeyT", metaKey: true, altKey: true })).toEqual({
      id: "text-align",
      align: "center",
    });
    expect(match(">", { code: "Period", metaKey: true, shiftKey: true })).toEqual({
      id: "text-step",
      step: "size",
      direction: 1,
    });
    expect(match("≤", { code: "Comma", metaKey: true, altKey: true })).toEqual({
      id: "text-step",
      step: "weight",
      direction: -1,
    });
    expect(match("˘", { code: "Period", altKey: true, shiftKey: true })).toEqual({
      id: "text-step",
      step: "line-height",
      direction: 1,
    });
    expect(match("≥", { code: "Period", altKey: true })).toEqual({
      id: "text-step",
      step: "letter-spacing",
      direction: 1,
    });
    // ⌘B / ⌘I / ⌘U, by key position, with a selection and a writable canvas only.
    expect(match("b", { code: "KeyB", metaKey: true })).toEqual({
      id: "text-format",
      format: "bold",
    });
    expect(match("и", { code: "KeyI", metaKey: true })).toEqual({
      id: "text-format",
      format: "italic",
    });
    expect(match("u", { code: "KeyU", metaKey: true })).toEqual({
      id: "text-format",
      format: "underline",
    });
    expect(match("b", { code: "KeyB", metaKey: true }, none)).toBeNull();
    expect(
      matchCanvasShortcut(press("b", { code: "KeyB", metaKey: true }), {
        ...context,
        readOnly: true,
      }),
    ).toBeNull();
  });

  it("binds ⌘⌫, ⇧F, ⌘⌥ with brackets and arrows, and ⌘⇧A", () => {
    expect(matchCanvasShortcut(press("Backspace", { metaKey: true }), context)).toEqual({
      id: "ungroup",
    });
    expect(matchCanvasShortcut(press("Backspace"), context)).toEqual({ id: "delete" });
    expect(matchCanvasShortcut(press("F", { code: "KeyF", shiftKey: true }), context)).toEqual({
      id: "frame-selection",
    });
    expect(matchCanvasShortcut(press("f", { code: "KeyF" }), context)).toEqual({
      id: "tool",
      tool: "frame",
    });
    expect(
      matchCanvasShortcut(
        press("‘", { code: "BracketRight", metaKey: true, altKey: true }),
        context,
      ),
    ).toEqual({ id: "arrange", mode: "front" });
    expect(
      matchCanvasShortcut(
        press("“", { code: "BracketLeft", metaKey: true, altKey: true }),
        context,
      ),
    ).toEqual({ id: "arrange", mode: "back" });
    expect(matchCanvasShortcut(press("ArrowUp", { metaKey: true, altKey: true }), context)).toEqual(
      { id: "arrange", mode: "forward" },
    );
    expect(
      matchCanvasShortcut(press("ArrowDown", { metaKey: true, altKey: true }), context),
    ).toEqual({ id: "arrange", mode: "backward" });
    expect(
      matchCanvasShortcut(press("A", { code: "KeyA", metaKey: true, shiftKey: true }), context),
    ).toEqual({
      id: "select-others",
    });
  });

  it("resizes the selection with ⌘ arrows, by the large step with ⇧, and keeps plain arrows as nudge", () => {
    expect(matchCanvasShortcut(press("ArrowRight", { metaKey: true }), context)).toEqual({
      id: "resize-by",
      dw: 1,
      dh: 0,
    });
    expect(
      matchCanvasShortcut(press("ArrowUp", { metaKey: true, shiftKey: true }), context),
    ).toEqual({ id: "resize-by", dw: 0, dh: -8 });
    expect(matchCanvasShortcut(press("ArrowLeft"), context)).toEqual({
      id: "nudge",
      dx: -1,
      dy: 0,
    });
    // ⌘⌥ arrows still step through the layer order; read-only canvases do not resize.
    expect(matchCanvasShortcut(press("ArrowUp", { metaKey: true, altKey: true }), context)).toEqual(
      { id: "arrange", mode: "forward" },
    );
    expect(
      matchCanvasShortcut(press("ArrowRight", { metaKey: true }), { ...context, readOnly: true }),
    ).toEqual({ id: "nudge", dx: 1, dy: 0 });
  });

  it("fits with ⌘⌥⇧R and fills with ⌘⌥⇧F", () => {
    const chord = { metaKey: true, altKey: true, shiftKey: true };
    expect(matchCanvasShortcut(press("R", { code: "KeyR", ...chord }), context)).toEqual({
      id: "resize-to",
      mode: "fit",
    });
    expect(matchCanvasShortcut(press("F", { code: "KeyF", ...chord }), context)).toEqual({
      id: "resize-to",
      mode: "fill",
    });
    expect(
      matchCanvasShortcut(press("R", { code: "KeyR", ...chord }), { ...context, selection: 0 }),
    ).toBeNull();
  });

  it("aligns several items with ⌥ letters and distributes three or more with ⌃⌥H / ⌃⌥V", () => {
    const two = { ...context, selection: 2, singleLayer: false };
    const three = { ...context, selection: 3, singleLayer: false };
    for (const [code, mode] of [
      ["KeyA", "left"],
      ["KeyD", "right"],
      ["KeyW", "top"],
      ["KeyS", "bottom"],
      ["KeyH", "center"],
      ["KeyV", "middle"],
    ] as const) {
      expect(matchCanvasShortcut(press("å", { code, altKey: true }), two)).toEqual({
        id: "align",
        mode,
      });
    }
    // One item has nothing to line up with; ⌥⇧A still removes flex.
    expect(matchCanvasShortcut(press("å", { code: "KeyA", altKey: true }), context)).toBeNull();
    expect(
      matchCanvasShortcut(press("Å", { code: "KeyA", altKey: true, shiftKey: true }), two),
    ).toEqual({ id: "remove-flex" });
    expect(
      matchCanvasShortcut(press("˙", { code: "KeyH", ctrlKey: true, altKey: true }), three),
    ).toEqual({ id: "distribute", axis: "x" });
    expect(
      matchCanvasShortcut(press("√", { code: "KeyV", ctrlKey: true, altKey: true }), three),
    ).toEqual({ id: "distribute", axis: "y" });
    expect(
      matchCanvasShortcut(press("˙", { code: "KeyH", ctrlKey: true, altKey: true }), two),
    ).toBeNull();
    // Where Ctrl is the command key, Ctrl+Alt+V stays Paste styles.
    expect(
      matchCanvasShortcut(press("v", { code: "KeyV", ctrlKey: true, altKey: true }, false), three),
    ).toEqual({ id: "paste-styles" });
  });

  it("deselects with ⇧Esc and strikes text through with ⌘⇧X", () => {
    expect(matchCanvasShortcut(press("Escape", { shiftKey: true }), context)).toEqual({
      id: "escape",
      deselect: true,
    });
    expect(matchCanvasShortcut(press("Escape"), context)).toEqual({
      id: "escape",
      deselect: false,
    });
    expect(
      matchCanvasShortcut(press("X", { code: "KeyX", metaKey: true, shiftKey: true }), context),
    ).toEqual({ id: "text-format", format: "strikethrough" });
    expect(matchCanvasShortcut(press("x", { code: "KeyX", metaKey: true }), context)).toEqual({
      id: "cut",
    });
  });
});

/** Every shortcut id, so a new one cannot be added without a guide entry (the type insists). */
const SHORTCUT_IDS: Record<CanvasShortcut["id"], true> = {
  "export-files": true,
  "copy-png": true,
  "copy-code": true,
  undo: true,
  redo: true,
  duplicate: true,
  "copy-styles": true,
  "paste-styles": true,
  wrap: true,
  "frame-selection": true,
  ungroup: true,
  "toggle-hidden": true,
  "toggle-locked": true,
  "unlock-all": true,
  copy: true,
  cut: true,
  "paste-special": true,
  rename: true,
  "select-all": true,
  "select-others": true,
  zoom: true,
  "zoom-100": true,
  "fit-all": true,
  "fit-selection": true,
  "opacity-digit": true,
  page: true,
  "frame-step": true,
  dashboard: true,
  "toggle-ui": true,
  "show-layers": true,
  "collapse-layers": true,
  "toggle-comments": true,
  delete: true,
  escape: true,
  "select-parent": true,
  enter: true,
  "cycle-sibling": true,
  "add-flex": true,
  "remove-flex": true,
  "clip-content": true,
  "text-align": true,
  "text-format": true,
  "text-step": true,
  arrange: true,
  nudge: true,
  tool: true,
  "hold-space": true,
  align: true,
  distribute: true,
  "resize-to": true,
  "resize-by": true,
};

describe("CANVAS_SHORTCUT_GUIDE", () => {
  it("documents a press that means each shortcut, for every shortcut", () => {
    for (const entry of CANVAS_SHORTCUT_GUIDE) {
      const on = { ...context, ...entry.context };
      expect(matchCanvasShortcut(canvasKeyOfPress(entry.press), on), entry.label).toEqual(
        entry.shortcut,
      );
    }
    const documented = new Set(CANVAS_SHORTCUT_GUIDE.map((entry) => entry.shortcut.id));
    expect(Object.keys(SHORTCUT_IDS).filter((id) => !documented.has(id as never))).toEqual([]);
  });

  it("spells a shortcut for tooltips on each platform", () => {
    expect(canvasShortcutLabelFor({ id: "align", mode: "left" }, "MacIntel")).toBe("⌥A");
    expect(canvasShortcutLabelFor({ id: "show-layers" }, "MacIntel")).toBe("⌥1");
    expect(canvasShortcutLabelFor({ id: "show-layers" }, "Win32")).toBe("Alt+1");
    expect(canvasShortcutLabelFor({ id: "distribute", axis: "y" }, "Win32")).toBeNull();
    expect(canvasShortcutLabelFor({ id: "rename" }, "MacIntel")).toBe("⌘R");
  });

  it("gives a context menu row the documented press, or a press of its own", () => {
    const plain = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(canvasMenuShortcut({ id: "duplicate" }, "Win32")).toEqual({
      shortcut: { key: "d", ...plain, modKey: true },
    });
    expect(canvasMenuShortcut({ id: "toggle-hidden" }, "MacIntel")).toEqual({
      shortcut: { key: "h", ...plain, shiftKey: true, modKey: true },
    });
    expect(canvasMenuShortcut({ id: "delete" }, "MacIntel")).toEqual({
      shortcut: { key: "backspace", ...plain, modKey: false },
    });
    // ⌘V is the browser's paste, not a guide entry; the row names it all the same.
    expect(canvasMenuShortcut({ key: "v", mod: true }, "MacIntel")).toEqual({
      shortcut: { key: "v", ...plain, modKey: true },
    });
    // No row key where the platform has no such press, or the shortcut has none.
    expect(canvasMenuShortcut({ id: "distribute", axis: "x" }, "Win32")).toEqual({});
    expect(canvasMenuShortcut({ id: "page", step: 1 }, "MacIntel")).toHaveProperty("shortcut");
    expect(canvasMenuShortcut({ id: "zoom", factor: 2 }, "MacIntel")).toEqual({});
  });
});
