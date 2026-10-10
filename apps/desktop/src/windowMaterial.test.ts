import { describe, expect, it, vi } from "vitest";

import {
  MAC_WINDOW_VIBRANCY,
  createWindowMaterialApplier,
  parseDesktopWindowMaterial,
} from "./windowMaterial";

function fakeWindow() {
  const handle = Buffer.alloc(8);
  return {
    handle,
    getNativeWindowHandle: vi.fn(() => handle),
    setVibrancy: vi.fn(),
  };
}

describe("parseDesktopWindowMaterial", () => {
  it("clamps and rounds the blur radius", () => {
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: 999 })).toEqual({
      material: "translucent",
      blurRadius: 64,
    });
    // An unblurred clear window is see-through, so translucent never drops below the floor.
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: -4.6 })).toEqual({
      material: "translucent",
      blurRadius: 1,
    });
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: 0 })).toEqual({
      material: "opaque",
      blurRadius: 0,
    });
  });

  it("rejects malformed input", () => {
    expect(parseDesktopWindowMaterial(null)).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "glass", blurRadius: 4 })).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: Number.NaN })).toBeNull();
  });
});

describe("createWindowMaterialApplier", () => {
  it("drops vibrancy and sets the blur radius when translucent", () => {
    const addon = { setBackgroundBlurRadius: vi.fn(() => true) };
    const apply = createWindowMaterialApplier(() => addon);
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 0 })).toBe(true);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(window.handle, 0);

    expect(apply(window, { material: "opaque", blurRadius: 30 })).toBe(true);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(MAC_WINDOW_VIBRANCY);
    expect(addon.setBackgroundBlurRadius).toHaveBeenLastCalledWith(window.handle, 0);
  });

  it("keeps vibrancy and loads the addon once when it is unavailable", () => {
    const loadAddon = vi.fn(() => null);
    const apply = createWindowMaterialApplier(loadAddon);
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 20 })).toBe(false);
    expect(apply(window, { material: "translucent", blurRadius: 10 })).toBe(false);
    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(window.setVibrancy).not.toHaveBeenCalledWith(null);
  });

  it("restores vibrancy when the window server refuses the blur", () => {
    const apply = createWindowMaterialApplier(() => ({ setBackgroundBlurRadius: () => false }));
    const window = fakeWindow();

    expect(apply(window, { material: "translucent", blurRadius: 20 })).toBe(false);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(MAC_WINDOW_VIBRANCY);
  });
});
