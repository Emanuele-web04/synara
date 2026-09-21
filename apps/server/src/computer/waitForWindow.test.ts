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
  it("does not infer a primary Notes window from accessory sizes", async () => {
    const notes = {
      ...window,
      title: "Notes",
      appName: "Notes",
      bounds: { x: 0, y: 0, width: 1000, height: 660 },
    };
    const checkInputReady = vi.fn(async () => {});
    expect(
      await waitForWindow(
        async () => [
          {
            ...notes,
            id: "8",
            title: "",
            visible: false,
            bounds: { x: 0, y: 0, width: 500, height: 500 },
          },
          { ...notes, id: "9", title: "Window", bounds: { x: 0, y: 0, width: 66, height: 20 } },
          notes,
        ],
        "Notes",
        0,
        undefined,
        { checkInputReady },
      ),
    ).toEqual({ window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" });
    expect(checkInputReady).not.toHaveBeenCalled();
  });
  it.each([
    { title: "", bounds: { x: 0, y: 0, width: 1000, height: 660 } },
    { title: "Document", bounds: { x: 0, y: 0, width: 0, height: 0 } },
  ])("does not bind a titled inspector over a document with $title", async (document) => {
    const checkInputReady = vi.fn(async () => {});
    const windows = [
      { ...window, ...document },
      { ...window, id: "8", title: "Inspector", bounds: { x: 0, y: 0, width: 240, height: 160 } },
    ];
    for (const candidates of [windows, [...windows].reverse()]) {
      expect(
        await waitForWindow(async () => candidates, "Helium", 0, undefined, { checkInputReady }),
      ).toEqual({ window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" });
    }
    expect(checkInputReady).not.toHaveBeenCalled();
  });
  it("keeps two real titled windows ambiguous regardless of size or order", async () => {
    const first = { ...window, bounds: { x: 0, y: 0, width: 120, height: 80 } };
    const second = {
      ...first,
      id: "8",
      title: "Other",
      bounds: { x: 0, y: 0, width: 1000, height: 660 },
    };
    expect(await waitForWindow(async () => [first, second], "Helium", 0)).toEqual({
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "ambiguous",
    });
  });
  it("keeps multiple hidden windows ambiguous", async () => {
    expect(
      await waitForWindow(
        async () => [
          { ...window, visible: false },
          { ...window, id: "8", visible: false },
        ],
        "Helium",
        0,
      ),
    ).toEqual({ window: null, windowStatus: "no_usable_window", windowReason: "ambiguous" });
  });
  it("keeps a single untitled window without bounds usable", async () => {
    const untitled = { ...window, title: "" };
    expect(await waitForWindow(async () => [untitled], "Helium", 0)).toEqual({
      window: untitled,
      windowStatus: "ready",
    });
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
