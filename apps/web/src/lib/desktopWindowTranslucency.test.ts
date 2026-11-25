// FILE: desktopWindowTranslucency.test.ts
// Purpose: Guard the renderer's read of the desktop's window backing, including a bridge
//          value the app does not recognize, which must not enable glass.

import { afterEach, describe, expect, it, vi } from "vitest";

import { readDesktopWindowTranslucency } from "./desktopWindowTranslucency";

type WindowSlot = { window?: unknown };

const originalWindow = (globalThis as WindowSlot).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as WindowSlot).window;
  else (globalThis as WindowSlot).window = originalWindow;
  vi.unstubAllGlobals();
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

  it.each(["native", "compositor", null] as const)(
    "inherits the controller window's backing in a Remote pane (%s)",
    (backing) => {
      vi.stubGlobal("navigator", { platform: "MacIntel" });
      const pane = {
        desktopBridge: { windowTranslucency: "native" },
        frameElement: {
          synaraWorkspace: {
            controller: {
              desktop: true,
              presentation: { readWindowTranslucency: () => backing },
            },
          },
        },
      };
      (globalThis as WindowSlot).window = pane;
      expect(readDesktopWindowTranslucency()).toBe(backing);
    },
  );

  it.each([
    { platform: "MacIntel", desktop: true, expected: "native" },
    { platform: "Linux x86_64", desktop: true, expected: null },
    { platform: "MacIntel", desktop: false, expected: null },
  ] as const)(
    "preserves legacy controller presentation on $platform (desktop=$desktop)",
    ({ platform, desktop, expected }) => {
      vi.stubGlobal("navigator", { platform });
      (globalThis as WindowSlot).window = {
        frameElement: { synaraWorkspace: { controller: { desktop, presentation: {} } } },
      };
      expect(readDesktopWindowTranslucency()).toBe(expected);
    },
  );

  it("keeps unknown values and non-desktop frames opaque", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    stubBridge("unknown-backing");
    expect(readDesktopWindowTranslucency()).toBeNull();
    (globalThis as WindowSlot).window = {
      frameElement: {
        synaraWorkspace: {
          controller: {
            desktop: false,
            presentation: { readWindowTranslucency: () => "native" },
          },
        },
      },
    };
    expect(readDesktopWindowTranslucency()).toBeNull();
    (globalThis as WindowSlot).window = {};
    expect(readDesktopWindowTranslucency()).toBeNull();
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
