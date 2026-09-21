import { describe, expect, it, vi } from "vitest";
import type { ComputerWindow } from "@synara/contracts";
import { waitForWindow } from "./waitForWindow.ts";

const window: ComputerWindow = {
  id: "7",
  title: "Draft",
  appName: "Helium",
  focused: false,
  minimized: false,
  visible: true,
};

describe("launch window readiness", () => {
  it("bounds a hung native window read and cancels its observation context", async () => {
    vi.useFakeTimers();
    try {
      const result = waitForWindow(() => new Promise(() => {}), "Helium", 500);
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toMatchObject({
        windowStatus: "no_usable_window",
        windowReason: "input_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an existing matching app window immediately", async () => {
    expect(await waitForWindow(async () => [window], "/Applications/Helium.app", 2_000)).toEqual({
      window,
      windowStatus: "ready",
    });
  });
  it("observes again when launch has not produced a window yet", async () => {
    let reads = 0;
    expect(await waitForWindow(async () => (++reads === 1 ? [] : [window]), "Helium", 500)).toEqual(
      { window, windowStatus: "ready" },
    );
    expect(reads).toBe(2);
  });
  it("does not choose between multiple app windows or unrelated apps", async () => {
    expect(
      await waitForWindow(async () => [window, { ...window, id: "8" }], "Helium", 0),
    ).toMatchObject({ window: null, windowStatus: "no_usable_window" });
    expect(await waitForWindow(async () => [window], "Other", 0)).toMatchObject({
      window: null,
      windowStatus: "no_usable_window",
    });
  });
  it("stops without another observation when cancelled", async () => {
    const controller = new AbortController();
    let reads = 0;
    await expect(
      waitForWindow(
        async () => {
          reads += 1;
          controller.abort();
          return [];
        },
        "Helium",
        500,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(reads).toBe(1);
  });
  it("uses the launched pid rather than a same-name process", async () => {
    const launched = { ...window, pid: 20 };
    expect(
      await waitForWindow(
        async () => [{ ...window, pid: 10 }, launched],
        "com.vendor.Helium",
        0,
        undefined,
        { pid: 20 },
      ),
    ).toEqual({ window: launched, windowStatus: "ready" });
  });
  it.each([
    [{ visible: false }, "hidden"],
    [{ minimized: true }, "hidden"],
    [{ onCurrentSpace: false }, "off_space"],
  ] as const)("does not bind an unusable window: %j", async (state, reason) => {
    expect(await waitForWindow(async () => [{ ...window, ...state }], "Helium", 0)).toEqual({
      window: null,
      windowStatus: "no_usable_window",
      windowReason: reason,
    });
  });
  it("does not mistake a listed window for native input readiness", async () => {
    expect(
      await waitForWindow(async () => [window], "Helium", 0, undefined, {
        checkInputReady: async () => {
          throw new Error("ax_window_unresolved");
        },
      }),
    ).toEqual({
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "input_unavailable",
    });
  });
  it("does not return readiness if Stop arrives during the probe", async () => {
    const controller = new AbortController();
    await expect(
      waitForWindow(async () => [window], "Helium", 0, controller.signal, {
        checkInputReady: async () => {
          controller.abort();
        },
      }),
    ).rejects.toThrow();
  });
});
