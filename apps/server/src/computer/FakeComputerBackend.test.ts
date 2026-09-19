import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

describe("FakeComputerBackend", () => {
  it("records the full snapshot and action surface without a display", async () => {
    const backend = new FakeComputerBackend();
    const events: string[] = [];
    backend.onEvent?.((event) => events.push(event.type));

    await backend.availability();
    await backend.listWindows();
    await backend.getScreenSize();
    await backend.getState({ includeScreenshot: true, includeTree: true });
    await backend.launchApp("org.example.Editor", ["--new"]);
    await backend.click({ x: 20, y: 20 });
    await backend.doubleClick({ x: 20, y: 20 });
    await backend.rightClick({ x: 20, y: 20 });
    await backend.moveCursor({ x: 20, y: 20 });
    await backend.drag({ x: 20, y: 20 }, { x: 30, y: 30 }, 100);
    await backend.scroll(null, 0, 500);
    await backend.typeText("hello");
    await backend.pressKey("Enter");
    await backend.hotkey(["Control", "L"]);

    expect(backend.calls.map((call) => call.method)).toEqual([
      "availability",
      "listWindows",
      "getScreenSize",
      "getState",
      "listWindows",
      "launchApp",
      "click",
      "doubleClick",
      "rightClick",
      "moveCursor",
      "drag",
      "scroll",
      "typeText",
      "pressKey",
      "hotkey",
    ]);
    expect(events).toContain("windows-changed");
  });

  it("emits codec-config and keyframe frames on request, and supports failures", async () => {
    const backend = new FakeComputerBackend();
    const frames: Array<{ keyframe: boolean; codecConfig: boolean }> = [];
    await backend.attachStream((frame) => frames.push(frame));
    // Attaching opens the tap and sends nothing by itself.
    expect(frames).toEqual([]);
    await backend.requestKeyframe?.();
    expect(frames).toEqual([
      expect.objectContaining({ keyframe: true, codecConfig: true }),
      expect.objectContaining({ keyframe: true, codecConfig: false }),
    ]);

    backend.failNext("click", new ComputerBackendError("synthetic click failure"));
    await expect(backend.click({ x: 1, y: 1 })).rejects.toThrow("synthetic click failure");
    await expect(backend.click({ x: 1, y: 1 })).resolves.toEqual({ point: { x: 1, y: 1 } });

    await backend.detachStream();
    backend.emitFrame(true, true);
    expect(frames.length).toBe(2);
  });

  it("connects on the first establishing call and refuses what a real backend refuses", async () => {
    const backend = new FakeComputerBackend();
    const health: string[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") health.push(event.health.status);
    });
    expect(backend.health().status).toBe("unavailable");
    await backend.probeAvailability();
    expect(backend.health().status).toBe("unavailable");
    await backend.availability();
    expect(backend.health().status).toBe("connected");
    expect(health).toEqual(["connected"]);

    await expect(backend.typeText("naïve")).rejects.toThrow(/cannot type/);
    await expect(backend.pressKey("key-500")).rejects.toThrow(/can press/);
    await expect(backend.hotkey(["ctrl", "a", "b"])).rejects.toThrow(/exactly one key/);
    const target = { target: {}, point: { x: 1, y: 1 }, node: (await backend.getState({})).root! };
    await expect(backend.performAction(target, "AXPress")).rejects.toThrow(/does not perform/);
    await expect(backend.performAction(target, "activate")).resolves.toMatchObject({
      value: "activate",
    });
    // Launching reports no window: it turns up through windows-changed.
    await expect(backend.launchApp("kcalc", [])).resolves.toMatchObject({ window: null });
    expect((await backend.listWindows()).some((window) => window.appName === "kcalc")).toBe(true);
    expect("tripleClick" in backend).toBe(false);
  });

  /**
   * A long-running server must not grow the call log forever; the oldest
   * entries fall off once the cap is reached.
   */
  it("caps recorded calls at a bounded recent window", () => {
    const backend = new FakeComputerBackend();
    for (let index = 0; index < 1_500; index += 1) {
      void backend.typeText(`text-${index}`);
    }
    expect(backend.calls.length).toBe(1_000);
    expect(backend.calls[0]?.args).toEqual(["text-500"]);
    expect(backend.calls.at(-1)?.args).toEqual(["text-1499"]);
  });
});
