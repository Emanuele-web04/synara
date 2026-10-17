import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";

import { updateRuntimeViewState } from "./terminalRuntime";
import type { TerminalRuntimeEntry } from "./terminalRuntimeTypes";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function setup() {
  const container = document.createElement("div");
  const wrapper = document.createElement("div");
  const terminalInput = document.createElement("textarea");
  wrapper.append(terminalInput);
  container.append(wrapper);
  const originalControl = document.createElement("input");
  const chosenControl = document.createElement("input");
  document.body.append(container, originalControl, chosenControl);
  originalControl.focus();
  expect(document.hasFocus()).toBe(true);
  const focus = vi.fn(() => terminalInput.focus());
  const entry = {
    container,
    wrapper,
    terminal: { focus },
    disposed: false,
    viewState: { autoFocus: true, isVisible: true },
  } as unknown as TerminalRuntimeEntry;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const runFrames = () => {
    for (const callback of frames.splice(0)) callback(performance.now());
  };
  return { entry, focus, frames, runFrames, originalControl, chosenControl, terminalInput };
}

function focusParentFrame() {
  const body = window.parent.document.body;
  const previousTabIndex = body.getAttribute("tabindex");
  body.tabIndex = -1;
  body.focus();
  expect(document.hasFocus()).toBe(false);
  return () => {
    if (previousTabIndex === null) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", previousTabIndex);
  };
}

it("automatically focuses a visible terminal in the active window", () => {
  const h = setup();
  updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
  h.runFrames();
  expect(h.focus).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(h.terminalInput);
});

it("automatically focuses a visible real xterm in the active window", () => {
  const h = setup();
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminal.open(h.entry.wrapper);
  h.entry.terminal = terminal;
  try {
    updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
    h.runFrames();
    expect(document.activeElement).toBe(terminal.textarea);
  } finally {
    terminal.dispose();
  }
});

it("does not schedule automatic focus from an inactive window", () => {
  const h = setup();
  const restoreParent = focusParentFrame();
  try {
    updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
    expect(h.frames).toHaveLength(0);
    expect(h.focus).not.toHaveBeenCalled();
    expect(document.hasFocus()).toBe(false);
  } finally {
    restoreParent();
  }
});

it("preserves a window blur between scheduling and the focus frame", () => {
  const h = setup();
  updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
  const restoreParent = focusParentFrame();
  try {
    h.runFrames();
    expect(h.focus).not.toHaveBeenCalled();
    expect(document.hasFocus()).toBe(false);
  } finally {
    restoreParent();
  }
});

it("preserves a different control chosen before the automatic focus frame", () => {
  const h = setup();
  updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
  h.chosenControl.focus();
  h.runFrames();
  expect(h.focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(h.chosenControl);
});

it.each(["hidden", "automatic focus disabled", "disposed", "detached"] as const)(
  "discards a queued focus after the terminal becomes %s",
  (change) => {
    const h = setup();
    updateRuntimeViewState(h.entry, { autoFocus: true, isVisible: true });
    if (change === "hidden") h.entry.viewState = { autoFocus: true, isVisible: false };
    if (change === "automatic focus disabled")
      h.entry.viewState = { autoFocus: false, isVisible: true };
    if (change === "disposed") h.entry.disposed = true;
    if (change === "detached") h.entry.container!.remove();
    h.runFrames();
    expect(h.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(h.originalControl);
  },
);
