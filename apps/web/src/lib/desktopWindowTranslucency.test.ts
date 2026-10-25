// FILE: desktopWindowTranslucency.test.ts
// Purpose: Guard the renderer's read of the desktop's window backing, including a bridge
//          value the app does not recognize, which must not enable glass.

import { afterEach, describe, expect, it } from "vitest";

import { readDesktopWindowTranslucency } from "./desktopWindowTranslucency";

type WindowSlot = { window?: unknown };

const originalWindow = (globalThis as WindowSlot).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as WindowSlot).window;
  else (globalThis as WindowSlot).window = originalWindow;
});

function stubBridge(windowTranslucency: unknown): void {
  (globalThis as WindowSlot).window = { desktopBridge: { windowTranslucency } };
}

describe("readDesktopWindowTranslucency", () => {
  it("reads the backing the desktop announced", () => {
    stubBridge("native");
    expect(readDesktopWindowTranslucency()).toBe("native");
    stubBridge("compositor");
    expect(readDesktopWindowTranslucency()).toBe("compositor");
  });

  it("stays null without a see-through window", () => {
    // Windows and Linux sessions without a blurring compositor, a window the desktop created
    // opaque, and a browser tab all leave the bridge without a value.
    stubBridge(undefined);
    expect(readDesktopWindowTranslucency()).toBeNull();
    (globalThis as WindowSlot).window = {};
    expect(readDesktopWindowTranslucency()).toBeNull();
    delete (globalThis as WindowSlot).window;
    expect(readDesktopWindowTranslucency()).toBeNull();
  });
});
