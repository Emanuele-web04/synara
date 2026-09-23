/**
 * The action and capture path of the shared Linux engine against plugins that
 * do and do not advertise the interface-version-2 features: every newer path
 * has an older plugin's fallback beside it, and both are pinned here.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KWinComputerBackend, type KWinComputerBackendOptions } from "./KWinComputerBackend.ts";
import type { AppLaunchResolution } from "./appLaunchResolution.ts";
import type { AtspiTreeReader } from "./atspiClient.ts";
import { FakeDbus, FakePlugin, pngOfSize } from "./computerPluginTestDoubles.ts";
import { withPaneInput } from "./paneInput.ts";

const atspi: AtspiTreeReader = {
  readTrees: async () => [],
  setText: async () => false,
  dispose: async () => undefined,
};

const backends: KWinComputerBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
});

function makeBackend(
  plugin: FakePlugin,
  options: Omit<KWinComputerBackendOptions, "dbus"> = {},
): KWinComputerBackend {
  const dbus = new FakeDbus(plugin);
  dbus.loaded = ["SynaraComputerUsePluginV10"];
  const backend = new KWinComputerBackend({
    clipboardToolsPresent: () => true,
    provisionClipboardTools: async () => {
      throw new Error("Unexpected clipboard installation");
    },
    linuxDistribution: () => ({ id: "arch" }),
    atspi,
    platform: "linux",
    sessionType: "wayland",
    installedPluginIds: async () => ["SynaraComputerUsePluginV10"],
    sleep: async () => undefined,
    resolveApp: (app, args) => ({ command: app, args: [...args], via: "path" }),
    installStampPath: join(tmpdir(), "synara-absent-install.stamp"),
    runningKwinVersion: async () => undefined,
    installedKwinVersion: async () => undefined,
    busNamesHaveOwners: async (names) => names.map(() => false),
    prebuiltRoot: () => undefined,
    buildToolingPresent: () => false,
    provisionPlugin: async () => {
      throw new Error("provisionPlugin was not stubbed in this test");
    },
    ...options,
    dbus,
  });
  backends.push(backend);
  return backend;
}

function callsOf(plugin: FakePlugin, method: string): number {
  return plugin.calls.filter((call) => call.method === method).length;
}

describe("pointer glides", () => {
  it("glides an agent's pointer but sends the pane's straight to the point", async () => {
    const plugin = new FakePlugin();
    const sleeps: number[] = [];
    const backend = makeBackend(plugin, {
      glideDurationMs: 180,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await backend.moveCursor({ x: 0, y: 0 });
    plugin.calls.length = 0;
    sleeps.length = 0;

    await backend.moveCursor({ x: 100, y: 0 });
    expect(callsOf(plugin, "movePointer")).toBeGreaterThanOrEqual(12);
    expect(sleeps.length).toBeGreaterThan(0);

    plugin.calls.length = 0;
    sleeps.length = 0;
    await withPaneInput(() => backend.moveCursor({ x: 200, y: 0 }));
    expect(callsOf(plugin, "movePointer")).toBeLessThanOrEqual(2);
    expect(sleeps).toEqual([]);
    expect(plugin.position).toEqual({ x: 200, y: 0 });
  });

  it("does not glide to the spot the pointer already occupies", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 180 });
    await backend.moveCursor({ x: 50, y: 50 });
    plugin.calls.length = 0;

    await backend.click({ x: 50, y: 50 });
    expect(callsOf(plugin, "movePointer")).toBe(1);
  });

  it("carries the pane marker through the manager's queued operation", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 180 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      await backend.moveCursor({ x: 0, y: 0 });
      plugin.calls.length = 0;
      await withPaneInput(() => manager.click(undefined, { x: 400, y: 0 }));
      // 400 px at the 80 px step bound, with no time-driven samples added.
      expect(callsOf(plugin, "movePointer")).toBeLessThanOrEqual(5);
      expect(plugin.position).toEqual({ x: 400, y: 0 });
    } finally {
      await manager.dispose();
    }
  });
});

/** Counts the plugin's window reads, which the double does not record itself. */
function countWindowReads(plugin: FakePlugin): { stateJson: number; windowsJson: number } {
  const counts = { stateJson: 0, windowsJson: 0 };
  const stateJson = plugin.stateJson;
  const windowsJson = plugin.windowsJson;
  plugin.stateJson = async () => {
    counts.stateJson += 1;
    return stateJson();
  };
  plugin.windowsJson = async () => {
    counts.windowsJson += 1;
    return windowsJson();
  };
  return counts;
}

describe("one window snapshot per desktop operation", () => {
  it("serves a click's repeated window reads from one enumeration", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      const counts = countWindowReads(plugin);
      await manager.withAgentActivity("thread-a", () =>
        manager.click("thread-a", { x: 1_000, y: 1_600, windowId: "window-1" }),
      );
      // Before the snapshot every read paid a stateJson + windowsJson pair.
      expect(counts.windowsJson).toBeLessThanOrEqual(2);
    } finally {
      await manager.dispose();
    }
  });

  it("reads afresh after input, and after the snapshot ages out", async () => {
    const plugin = new FakePlugin();
    let now = 1_000;
    const backend = makeBackend(plugin, { glideDurationMs: 0, now: () => now });
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const queue = new DesktopOperationQueue();
    await backend.availability();
    const counts = countWindowReads(plugin);
    await queue.run(async () => {
      await backend.listWindows();
      await backend.listWindows();
      expect(counts.windowsJson).toBe(1);
      await backend.click({ x: 10, y: 10 });
      await backend.listWindows();
      expect(counts.windowsJson).toBe(2);
      now += 100;
      await backend.listWindows();
      expect(counts.windowsJson).toBe(3);
    });
    // Outside any operation nothing is cached at all.
    await backend.listWindows();
    await backend.listWindows();
    expect(counts.windowsJson).toBe(5);
  });

  it("uses windowsStateJson in place of the stateJson + windowsJson pair when advertised", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["windowsStateJson"];
    plugin.workspace = { x: -1_920, y: 0, width: 3_840, height: 1_080 };
    const backend = makeBackend(plugin);
    await backend.availability();
    const counts = countWindowReads(plugin);
    const windows = await backend.listWindows();
    expect(counts).toEqual({ stateJson: 0, windowsJson: 0 });
    expect(callsOf(plugin, "windowsStateJson")).toBe(1);
    expect(windows.map((window) => window.id)).toEqual(["window-1"]);
    expect(windows[0]?.focused).toBe(true);
    // Agent space is anchored at the reported workspace origin.
    expect(windows[0]?.bounds).toEqual({ x: 956 + 1_920, y: 1_519, width: 648, height: 518 });

    // A monitor added to the left moves the origin at the next read.
    plugin.workspace = { x: -3_840, y: 0, width: 5_760, height: 1_080 };
    const moved = await backend.listWindows();
    expect(moved[0]?.bounds?.x).toBe(956 + 3_840);
  });

  it("treats the combined document's lock flag as the answer, windows or not", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["windowsStateJson"];
    const backend = makeBackend(plugin);
    await backend.availability();
    // Hyprland keeps listing windows while locked; KWin sends none.
    plugin.windowsStateJson = async () =>
      JSON.stringify({ windows: plugin.windows, targetWindowId: null, locked: true });
    const events: string[] = [];
    backend.onEvent((event) => {
      if (event.type === "desktop-interrupted") events.push(event.pauses.join(","));
    });
    const error = await backend.listWindows().catch((caught: unknown) => caught);
    expect(String(error)).toContain("computer_session_locked");
    expect((error as { inputPause?: unknown }).inputPause).toBeDefined();
    expect(events).toEqual(["screen-lock"]);
  });

  it("keeps the version-1 reads on a plugin that does not advertise the combined document", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin);
    await backend.availability();
    const counts = countWindowReads(plugin);
    await backend.listWindows();
    expect(counts).toEqual({ stateJson: 1, windowsJson: 1 });
    expect(callsOf(plugin, "windowsStateJson")).toBe(0);
  });
});

const PNG_A = pngOfSize(10, 10);
const PNG_B = pngOfSize(10, 11);
const JPEG_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);

describe("preview stills", () => {
  it("asks a captureEx plugin for passive JPEG stills at the preview budget", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.captureMime = "image/jpeg";
    plugin.captureBytes = JPEG_BYTES;
    plugin.workspace = { x: 0, y: 0, width: 1_920, height: 1_080 };
    const backend = makeBackend(plugin);
    const frames: { mimeType?: string; data: Uint8Array }[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(plugin.calls).toContainEqual({
      method: "captureRegionEx",
      args: [0, 0, 1_920, 1_080, 1_280, 1 | 2],
    });
    expect(callsOf(plugin, "captureRegion")).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.mimeType).toBe("image/jpeg");
    // The session was never started for watching.
    expect(callsOf(plugin, "start")).toBe(0);
  });

  it("refuses a still whose bytes are not the image they claim to be", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.captureMime = "image/jpeg";
    const backend = makeBackend(plugin);
    const frames: unknown[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(frames).toEqual([]);
  });

  it("keeps PNG stills from captureRegion on a plugin without captureEx", async () => {
    const plugin = new FakePlugin();
    plugin.workspace = { x: 0, y: 0, width: 1_920, height: 1_080 };
    const backend = makeBackend(plugin);
    const frames: { mimeType?: string }[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 1_920, 1_080, 1_280],
    });
    expect(callsOf(plugin, "captureRegionEx")).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.mimeType).toBeUndefined();
  });

  it("slows an idle pane to one still every two seconds and wakes on an action", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    await vi.advanceTimersByTimeAsync(2_000);
    // 500 ms ticks until four identical stills, then the idle interval.
    expect(captures()).toBe(1 + 4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(captures()).toBe(1 + 5);

    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    await new DesktopOperationQueue().run(() => backend.click({ x: 10, y: 10 }));
    const afterAction = captures();
    await vi.advanceTimersByTimeAsync(600);
    expect(captures()).toBeGreaterThan(afterAction);
  });

  it("holds stills while a desktop operation runs and takes one right after it", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const release = Promise.withResolvers<void>();
    const operation = new DesktopOperationQueue().run(async () => {
      await backend.moveCursor({ x: 10, y: 10 });
      await release.promise;
    });
    await vi.advanceTimersByTimeAsync(0);
    const during = captures();
    await vi.advanceTimersByTimeAsync(900);
    expect(captures()).toBe(during);
    release.resolve();
    await operation;
    await vi.advanceTimersByTimeAsync(60);
    expect(captures()).toBe(during + 1);
  });

  it("lets a still through a long operation once a second", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    let frame = 0;
    // Changing stills, so the idle backoff stays out of the picture.
    plugin.captureRegion = async () => {
      plugin.calls.push({ method: "captureRegion", args: [] });
      frame += 1;
      return frame % 2 === 0 ? PNG_A : PNG_B;
    };
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const release = Promise.withResolvers<void>();
    const operation = new DesktopOperationQueue().run(async () => {
      for (let tick = 0; tick < 30; tick += 1) {
        await backend.listWindows();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await release.promise;
    });
    const before = captures();
    await vi.advanceTimersByTimeAsync(3_000);
    const during = captures() - before;
    expect(during).toBeGreaterThanOrEqual(2);
    expect(during).toBeLessThanOrEqual(4);
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await operation;
  });
});

/** A plugin answering the three settle waits by their bounds. */
function answeringSettle(
  plugin: FakePlugin,
  answers: {
    readonly first: readonly [boolean, number];
    readonly quiet?: readonly [boolean, number];
    readonly changed: boolean;
  },
): void {
  plugin.waitForSettle = async (windowId, quietMs, timeoutMs) => {
    plugin.calls.push({ method: "waitForSettle", args: [windowId, quietMs, timeoutMs] });
    if (timeoutMs === 300) return answers.first;
    if (timeoutMs === 0) return [answers.changed, 0] as const;
    // The rest-of-the-bound quiet wait; never answered when nothing changed.
    return answers.quiet ?? new Promise<never>(() => undefined);
  };
}

describe("compositor-observed settle", () => {
  it("is offered only while the loaded plugin advertises waitForSettle", async () => {
    const old = makeBackend(new FakePlugin());
    await old.availability();
    expect(old.waitForSettle).toBeUndefined();

    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    const backend = makeBackend(plugin);
    expect(backend.waitForSettle).toBeUndefined();
    await backend.availability();
    plugin.settleAnswer = [true, 42];
    await expect(
      backend.waitForSettle!({ windowId: "window-1", quietMs: 100, timeoutMs: 1_500 }),
    ).resolves.toEqual({ settled: true, waitedMs: 42 });
    expect(plugin.calls).toContainEqual({
      method: "waitForSettle",
      args: ["window-1", 100, 1_500],
    });
  });

  it("waits blind for the quiet window when the plugin cannot observe the target", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.settleAnswer = [false, 0];
    const sleeps: number[] = [];
    const backend = makeBackend(plugin, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await backend.availability();
    await expect(
      backend.waitForSettle!({ windowId: "gone", quietMs: 100, timeoutMs: 1_500 }),
    ).resolves.toEqual({ settled: false, waitedMs: 100 });
    expect(sleeps).toEqual([100]);
  });

  it("replaces the manager's fixed post-action wait with a short commit-driven one", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.settleAnswer = [true, 30];
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({ backend });
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await backend.availability();
      await manager.withAgentActivity("thread-a", async () => {
        await manager.pressKey("thread-a", "enter");
        await manager.captureActionScreenshot("window-1");
      });
      // Quiet, looked for as long as the old fixed wait; it came at once.
      expect(plugin.calls.filter((call) => call.method === "waitForSettle")).toEqual([
        { method: "waitForSettle", args: ["window-1", 100, 300] },
      ]);
      // No blind 300 ms timer ran beside it.
      expect(timers.mock.calls.some((call) => call[1] === 300)).toBe(false);
    } finally {
      timers.mockRestore();
      await manager.dispose();
    }
  });

  it.each([
    [
      "photographs an animating window when quiet does not come, as the fixed wait did",
      // Never quiet within 300 ms; it has repainted, so the check answers at once.
      [
        [false, 300],
        [true, 0],
      ],
      { settled: true, waitedMs: 300 },
    ],
    [
      "gives a window that has not repainted yet the rest of the cap for its first frame",
      [
        [false, 300],
        [true, 540],
      ],
      { settled: true, waitedMs: 840 },
    ],
    [
      "gives up at the cap on a window that never repaints",
      [
        [false, 300],
        [false, 1_200],
      ],
      { settled: false, waitedMs: 1_500 },
    ],
  ] as const)("%s", async (_label, replies, expected) => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    const answers = [...replies];
    plugin.waitForSettle = async (windowId, quietMs, timeoutMs) => {
      plugin.calls.push({ method: "waitForSettle", args: [windowId, quietMs, timeoutMs] });
      return answers.shift()!;
    };
    const backend = makeBackend(plugin);
    await backend.availability();
    await expect(
      backend.waitForSettle!({
        windowId: "window-1",
        quietMs: 100,
        timeoutMs: 1_500,
        quietWithinMs: 300,
      }),
    ).resolves.toEqual(expected);
    expect(plugin.calls.filter((call) => call.method === "waitForSettle")).toEqual([
      { method: "waitForSettle", args: ["window-1", 100, 300] },
      { method: "waitForSettle", args: ["window-1", 0, 1_200] },
    ]);
  });

  describe("with a first-change bound (the post-action policy)", () => {
    const options = {
      windowId: "window-1",
      quietMs: 100,
      timeoutMs: 1_500,
      changeWithinMs: 300,
    } as const;

    it("settles a window that repainted and went quiet within the bound at once", async () => {
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      answeringSettle(plugin, { first: [true, 130], changed: true });
      const backend = makeBackend(plugin);
      await backend.availability();
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: true,
        waitedMs: 130,
      });
      expect(callsOf(plugin, "waitForSettle")).toBe(1);
    });

    it("takes a window that has not repainted at all by the bound as unchanged", async () => {
      // Was: the rest of the 1.5 s cap for a first frame that never came.
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      answeringSettle(plugin, { first: [false, 300], changed: false });
      const backend = makeBackend(plugin);
      await backend.availability();
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: true,
        waitedMs: 300,
      });
      // The quiet wait goes out before the question that would retire the
      // input, so it still measures from the action.
      expect(plugin.calls.filter((call) => call.method === "waitForSettle")).toEqual([
        { method: "waitForSettle", args: ["window-1", 100, 300] },
        { method: "waitForSettle", args: ["window-1", 100, 1_200] },
        { method: "waitForSettle", args: ["window-1", 0, 0] },
      ]);
    });

    it("waits out the quiet of a window that did repaint, up to the cap", async () => {
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      answeringSettle(plugin, { first: [false, 300], quiet: [true, 140], changed: true });
      const backend = makeBackend(plugin);
      await backend.availability();
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: true,
        waitedMs: 440,
      });

      answeringSettle(plugin, { first: [false, 300], quiet: [false, 1_200], changed: true });
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: false,
        waitedMs: 1_500,
      });
      // Both saw a repaint: still observing.
      expect(backend.waitForSettle).toBeDefined();
    });

    it("photographs a window still animating at the bound as it is (the backend's policy)", async () => {
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      answeringSettle(plugin, { first: [false, 300], changed: true });
      const backend = makeBackend(plugin);
      await backend.availability();
      expect(backend.actionSettle).toMatchObject({ quietWithinMs: 300, changeWithinMs: 300 });
      await expect(
        backend.waitForSettle!({ ...options, ...backend.actionSettle }),
      ).resolves.toEqual({ settled: false, waitedMs: 300 });
      // Nothing is left waiting in the plugin: the quiet bound is spent.
      expect(plugin.calls.filter((call) => call.method === "waitForSettle")).toEqual([
        { method: "waitForSettle", args: ["window-1", 100, 300] },
        { method: "waitForSettle", args: ["window-1", 0, 0] },
      ]);
      expect(backend.waitForSettle).toBeDefined();
    });

    it("keeps observing through any run of actions that changed nothing", async () => {
      // "Unchanged" is the ordinary answer to an inert click, not a blind
      // plugin: counting it gave the fixed wait back after three of them.
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      answeringSettle(plugin, { first: [false, 300], changed: false });
      const backend = makeBackend(plugin);
      await backend.availability();
      for (let settle = 0; settle < 5; settle += 1) {
        await expect(backend.waitForSettle!(options)).resolves.toEqual({
          settled: true,
          waitedMs: 300,
        });
      }
      expect(backend.waitForSettle).toBeDefined();
    });

    it("waits the bound blind for a window the compositor is not painting", async () => {
      const plugin = new FakePlugin();
      plugin.features = ["waitForSettle"];
      plugin.windows = [{ ...plugin.windows[0]!, visible: false }];
      const sleeps: number[] = [];
      const backend = makeBackend(plugin, {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      });
      await backend.availability();
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: false,
        waitedMs: 300,
      });
      expect(sleeps).toEqual([300]);
    });
  });

  it("gives the fixed wait back after three settles in a row that saw no repaint at all", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.waitForSettle = async (windowId, quietMs, timeoutMs) => {
      plugin.calls.push({ method: "waitForSettle", args: [windowId, quietMs, timeoutMs] });
      return [false, timeoutMs] as const;
    };
    const backend = makeBackend(plugin);
    await backend.availability();
    const options = { windowId: "window-1", quietMs: 100, timeoutMs: 1_500, quietWithinMs: 300 };
    for (let miss = 0; miss < 3; miss += 1) {
      await expect(backend.waitForSettle!(options)).resolves.toEqual({
        settled: false,
        waitedMs: 1_500,
      });
    }
    // The manager's fixed post-action wait from here on.
    expect(backend.waitForSettle).toBeUndefined();
  });

  it("keeps observing when a settle between the misses saw a repaint", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    const answers: (readonly [boolean, number])[] = [
      [false, 300],
      [false, 1_200],
      [false, 300],
      [false, 1_200],
      [true, 40],
      [false, 300],
      [false, 1_200],
    ];
    plugin.waitForSettle = async () => answers.shift()!;
    const backend = makeBackend(plugin);
    await backend.availability();
    const options = { windowId: "window-1", quietMs: 100, timeoutMs: 1_500, quietWithinMs: 300 };
    for (let settle = 0; settle < 4; settle += 1) await backend.waitForSettle!(options);
    expect(backend.waitForSettle).toBeDefined();
  });

  it("waits blind rather than to the cap for a window the compositor is not painting", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.windows = [{ ...plugin.windows[0]!, visible: false }];
    const sleeps: number[] = [];
    const backend = makeBackend(plugin, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await backend.availability();
    await expect(
      backend.waitForSettle!({
        windowId: "window-1",
        quietMs: 100,
        timeoutMs: 1_500,
        quietWithinMs: 300,
      }),
    ).resolves.toEqual({ settled: false, waitedMs: 300 });
    expect(callsOf(plugin, "waitForSettle")).toBe(0);
    expect(sleeps).toEqual([300]);
  });

  it("waits for real quiet when the caller sets no bound (an explicit wait)", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.settleAnswer = [true, 640];
    const backend = makeBackend(plugin);
    await backend.availability();
    await expect(
      backend.waitForSettle!({ windowId: "window-1", quietMs: 300, timeoutMs: 10_000 }),
    ).resolves.toEqual({ settled: true, waitedMs: 640 });
    expect(plugin.calls.filter((call) => call.method === "waitForSettle")).toEqual([
      { method: "waitForSettle", args: ["window-1", 300, 10_000] },
    ]);
  });

  it("keeps the fixed post-action wait on a plugin without waitForSettle", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({ backend });
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await backend.availability();
      await manager.withAgentActivity("thread-a", async () => {
        await manager.pressKey("thread-a", "enter");
        await manager.captureActionScreenshot("window-1");
      });
      expect(callsOf(plugin, "waitForSettle")).toBe(0);
      expect(timers.mock.calls.some((call) => call[1] === 300)).toBe(true);
    } finally {
      timers.mockRestore();
      await manager.dispose();
    }
  });
});

describe("batched typing through keys", () => {
  it("types a word per keys call when the plugin advertises it", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(4).slice(0, 180);
    await expect(backend.typeText(text)).resolves.toEqual({ value: text });
    expect(callsOf(plugin, "key")).toBe(0);
    const batches = plugin.calls
      .filter((call) => call.method === "keys")
      .map((call) => call.args[0] as readonly (readonly [number, boolean])[]);
    // One call per word, where single keys took 2-4 calls a character.
    expect(batches.length).toBe(text.split(" ").filter(Boolean).length);
    expect(batches.every((batch) => batch.length <= 32)).toBe(true);
    const presses = batches.flat().filter(([, pressed]) => pressed).length;
    expect(presses).toBeGreaterThanOrEqual(text.length);
  });

  it("reports the partial result and releases what a cut-short batch left held", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    let call = 0;
    plugin.keys = async (strokes) => {
      plugin.calls.push({ method: "keys", args: [strokes] });
      call += 1;
      // "hello " lands; "World" stops after W's Shift and press.
      return call === 1 ? strokes.length : 2;
    };
    const error = await backend.typeText("hello World").catch((caught: unknown) => caught);
    expect(String(error)).toContain("Typing stopped after 6 of 11 characters");
    expect(String(error)).toContain('"hello "');
    // W's key, then Shift, released one by one.
    const releases = plugin.calls
      .filter((entry) => entry.method === "key")
      .map((entry) => entry.args);
    expect(releases).toEqual([
      [17, false],
      [42, false],
    ]);
  });

  it("throws the plugin's own refusal when nothing was typed", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const refusal = Object.assign(new Error("human is typing"), {
      type: "org.synara.ComputerUse.Error.HumanActive",
    });
    plugin.inputFailure = { method: "keys", error: refusal };
    const backend = makeBackend(plugin);
    await backend.availability();
    const error = await backend.typeText("abc").catch((caught: unknown) => caught);
    expect(String(error)).toContain("computer_human_active");
    expect(String(error)).not.toContain("Typing stopped");
  });

  it("restarts a session that stopped under it and resends the batch once", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    await backend.moveCursor({ x: 1, y: 1 });
    // The idle deadline expired between two actions.
    plugin.running = false;
    await expect(backend.typeText("ok")).resolves.toEqual({ value: "ok" });
    expect(callsOf(plugin, "start")).toBe(2);
    expect(callsOf(plugin, "keys")).toBe(2);
  });

  it("keeps single key calls on a plugin without keys", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin);
    await backend.availability();
    await backend.typeText("Hi");
    expect(callsOf(plugin, "keys")).toBe(0);
    expect(callsOf(plugin, "key")).toBe(6);
  });
});

describe("luma capture", () => {
  it("captures a window as raw luma through captureWindowEx, with the screenshot's geometry", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    // The fake window is 648x518 at (956, 1519); rendered at half size.
    plugin.captureMime = "image/x-luma8; width=324; height=259";
    plugin.captureBytes = new Uint8Array(324 * 259).fill(7);
    const backend = makeBackend(plugin);
    await backend.availability();
    const luma = await backend.captureLuma({ kind: "window", windowId: "window-1" });
    expect(luma).toMatchObject({ width: 324, height: 259, scale: 0.5 });
    expect(luma.data.byteLength).toBe(324 * 259);
    expect(plugin.calls).toContainEqual({
      method: "captureWindowEx",
      args: ["window-1", 1_536, 4],
    });
  });

  it("captures a region as luma in the plugin's global space", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.workspace = { x: -100, y: 0, width: 1_000, height: 800 };
    plugin.captureMime = "image/x-luma8; width=200; height=100";
    plugin.captureBytes = new Uint8Array(200 * 100);
    const backend = makeBackend(plugin);
    await backend.availability();
    const luma = await backend.captureLuma({
      kind: "region",
      region: { x: 0, y: 0, width: 200, height: 100 },
      maxDimension: 800,
    });
    expect(luma.scale).toBe(1);
    expect(plugin.calls).toContainEqual({
      method: "captureRegionEx",
      args: [-100, 0, 200, 100, 800, 4],
    });
  });

  it("refuses luma whose bytes do not fill the size it names", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.captureMime = "image/x-luma8; width=10; height=10";
    plugin.captureBytes = new Uint8Array(99);
    const backend = makeBackend(plugin);
    await backend.availability();
    await expect(backend.captureLuma({ kind: "window", windowId: "window-1" })).rejects.toThrow(
      "usable luma image",
    );
  });

  it("refuses on a plugin without captureEx, so the manager takes a screenshot", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin);
    await backend.availability();
    await expect(backend.captureLuma({ kind: "window", windowId: "window-1" })).rejects.toThrow(
      "cannot capture raw luma",
    );
    expect(callsOf(plugin, "captureWindowEx")).toBe(0);
  });
});

/** A spawned process that starts at once under `pid`. */
function spawnedAs(pid: number): () => ChildProcess {
  return () => {
    const child = Object.assign(new EventEmitter(), { pid, unref: () => undefined });
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
}

describe("the driven session's environment", () => {
  it("launches apps with the session environment a subclass names", async () => {
    class ElsewhereBackend extends KWinComputerBackend {
      protected override async desktopSessionEnvironment() {
        return { WAYLAND_DISPLAY: "wayland-9", DISPLAY: undefined };
      }
    }
    const spawned: NodeJS.ProcessEnv[] = [];
    const plugin = new FakePlugin();
    const dbus = new FakeDbus(plugin);
    dbus.loaded = ["SynaraComputerUsePluginV10"];
    const backend = new ElsewhereBackend({
      clipboardToolsPresent: () => true,
      linuxDistribution: () => ({ id: "arch" }),
      atspi,
      platform: "linux",
      sessionType: "wayland",
      installedPluginIds: async () => ["SynaraComputerUsePluginV10"],
      sleep: async () => undefined,
      resolveApp: (app, args) => ({ command: app, args: [...args], via: "path" }),
      installStampPath: join(tmpdir(), "synara-absent-install.stamp"),
      runningKwinVersion: async () => undefined,
      installedKwinVersion: async () => undefined,
      busNamesHaveOwners: async (names) => names.map(() => false),
      prebuiltRoot: () => undefined,
      buildToolingPresent: () => false,
      env: { HOME: "/home/test", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", PATH: "/usr/bin" },
      spawnProcess: (command, args, options) => {
        spawned.push(options.env);
        return spawnedAs(4_242)();
      },
      dbus,
    });
    backends.push(backend);
    await backend.availability();
    await backend.launchApp("kate", []);
    expect(spawned[0]).toMatchObject({ WAYLAND_DISPLAY: "wayland-9", PATH: "/usr/bin" });
    expect(spawned[0]).not.toHaveProperty("DISPLAY");
    expect(spawned[0]?.ACCESSIBILITY_ENABLED).toBe("1");
  });
});

describe("launch results", () => {
  it.each([
    [
      "a plain executable, matched by pid alone",
      { command: "/usr/bin/kate", args: [], via: "path" },
      undefined,
    ],
    [
      "a desktop entry run through gio, named by its file",
      {
        command: "/usr/bin/gio",
        args: ["launch", "/usr/share/applications/org.kde.kate.desktop"],
        via: "desktop-entry-gio",
        desktopFile: "/usr/share/applications/org.kde.kate.desktop",
      },
      "org.kde.kate",
    ],
    [
      "a flatpak export, named by its app id",
      {
        command: "/var/lib/flatpak/exports/bin/org.mozilla.firefox",
        args: [],
        via: "flatpak-export",
      },
      "org.mozilla.firefox",
    ],
  ] as const)("reports the pid and app id of %s", async (_label, resolution, appId) => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, {
      resolveApp: () => resolution as AppLaunchResolution,
      spawnProcess: spawnedAs(4_242),
    });
    await backend.availability();
    const result = await backend.launchApp("kate", []);
    expect(result.pid).toBe(4_242);
    expect(result.appId).toBe(appId);
  });

  it.each([
    ["reports a launch whose window took activation", 4_242, true],
    ["does not blame the launch for the human moving their own focus", 99, undefined],
  ] as const)("%s", async (_label, activePid, expected) => {
    const plugin = new FakePlugin();
    plugin.windows = [{ ...plugin.windows[0]!, active: true }];
    const launchedWindow = {
      id: "launched",
      title: "New",
      appName: "org.example.New",
      pid: activePid,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      focused: false,
      minimized: false,
      visible: true,
      active: true,
    };
    const backend = makeBackend(plugin, {
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), { pid: 4_242, unref: () => undefined });
        queueMicrotask(() => {
          plugin.windows = [{ ...plugin.windows[0]!, active: false }, launchedWindow];
          child.emit("spawn");
        });
        return child as unknown as ChildProcess;
      },
    });
    await backend.availability();
    const result = await backend.launchApp("new", []);
    expect(result.focusChangedDuringLaunch).toBe(expected);
  });

  it("lets the manager find a launched window whose app name differs from the launch name", async () => {
    const plugin = new FakePlugin();
    plugin.windows = [
      {
        id: "kate-window",
        title: "Untitled — Kate",
        appName: "org.kde.kate",
        pid: 4_242,
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        focused: false,
        minimized: false,
        visible: true,
      },
    ];
    const backend = makeBackend(plugin, { spawnProcess: spawnedAs(4_242) });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      const result = await manager.withAgentActivity("thread-a", () =>
        manager.launchApp("thread-a", "kate", [], 2_000),
      );
      expect(result.windowStatus).toBe("ready");
      expect(result.window?.id).toBe("kate-window");
    } finally {
      await manager.dispose();
    }
  });
});

describe("paste-once clipboard", () => {
  it("puts the human's clipboard back as soon as the paste has read the offer", async () => {
    const plugin = new FakePlugin();
    const commands: string[] = [];
    const pasted = Promise.withResolvers<void>();
    const backend = makeBackend(plugin, {
      runClipboardCommand: async (spec) => {
        commands.push([spec.command, ...spec.args, spec.input ?? ""].join(" ").trim());
        if (spec.command === "wl-paste") {
          return { outcome: "exited", code: 0, stdout: "human text", stderr: "" };
        }
        return {
          outcome: "exited",
          code: 0,
          stdout: "",
          stderr: "",
          ...(spec.args.includes("--paste-once") ? { forkExited: pasted.promise } : {}),
        };
      },
    });
    // The target reads the offer the moment Ctrl+V goes down.
    const key = plugin.key;
    plugin.key = async (code, pressed) => {
      if (code === 47 && pressed) queueMicrotask(() => pasted.resolve());
      return key(code, pressed);
    };
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      const startedAt = Date.now();
      const result = await manager.withAgentActivity("thread-a", () =>
        manager.paste("thread-a", "agent text"),
      );
      expect(result.clipboardRestored).toBe(true);
      expect(commands).toEqual([
        "wl-paste --no-newline --type text",
        "wl-copy --paste-once --type text/plain agent text",
        "wl-copy --type text/plain human text",
      ]);
      // The 2 s bound was not waited out; the fixed settle is the floor.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(245);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await manager.dispose();
    }
  });

  it("writes the payload again when a clipboard watcher took the offer before the paste", async () => {
    const plugin = new FakePlugin();
    const commands: string[] = [];
    let clipboard = "human text";
    const backend = makeBackend(plugin, {
      runClipboardCommand: async (spec) => {
        commands.push([spec.command, ...spec.args, spec.input ?? ""].join(" ").trim());
        if (spec.command === "wl-paste") {
          return { outcome: "exited", code: 0, stdout: clipboard, stderr: "" };
        }
        const offer = spec.args.includes("--paste-once");
        // A history daemon reads every new selection at once; wl-copy
        // --paste-once serves that one read and exits, leaving nothing.
        clipboard = offer ? "" : (spec.input ?? "");
        return {
          outcome: "exited",
          code: 0,
          stdout: "",
          stderr: "",
          ...(offer ? { forkExited: Promise.resolve() } : {}),
        };
      },
    });
    const pastedTexts: string[] = [];
    const key = plugin.key;
    plugin.key = async (code, pressed) => {
      if (code === 47 && pressed) pastedTexts.push(clipboard);
      return key(code, pressed);
    };
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      await manager.withAgentActivity("thread-a", () => manager.paste("thread-a", "first"));
      await manager.withAgentActivity("thread-a", () => manager.paste("thread-a", "second"));
      // Ctrl+V found the payload both times, and the human's text came back.
      expect(pastedTexts).toEqual(["first", "second"]);
      expect(clipboard).toBe("human text");
      expect(commands).toEqual([
        "wl-paste --no-newline --type text",
        "wl-copy --paste-once --type text/plain first",
        "wl-copy --type text/plain first",
        "wl-copy --type text/plain human text",
        "wl-paste --no-newline --type text",
        // A watcher was seen: no offer this time.
        "wl-copy --type text/plain second",
        "wl-copy --type text/plain human text",
      ]);
    } finally {
      await manager.dispose();
    }
  });

  it("withdraws an offer nobody pasted when the backend goes away", async () => {
    const plugin = new FakePlugin();
    const ended: string[] = [];
    const offers = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const backend = makeBackend(plugin, {
      runClipboardCommand: async (spec) => {
        const text = spec.input ?? "";
        const pending = Promise.withResolvers<void>();
        offers.set(text, pending);
        return {
          outcome: "exited",
          code: 0,
          stdout: "",
          stderr: "",
          forkExited: pending.promise,
          endFork: () => {
            ended.push(text);
            pending.resolve();
          },
        };
      },
    });
    await backend.availability();
    const unpasted = await backend.writeClipboardForPaste("agent text");
    const pasted = await backend.writeClipboardForPaste("pasted text");
    offers.get("pasted text")!.resolve();
    // Read with no shortcut sent: a watcher's read, reported as unobserved.
    await expect(pasted.consumed).rejects.toThrow(/watcher/);
    expect(ended).toEqual([]);
    await backend.dispose();
    // Only the offer still on the clipboard; a consumed one is forgotten.
    expect(ended).toEqual(["agent text"]);
    await unpasted.consumed.catch(() => undefined);
  });
});

/** Two 1920x1080 monitors side by side, the left one at a negative x. */
function twoMonitors(plugin: FakePlugin, outputs?: readonly unknown[]): void {
  plugin.features = ["windowsStateJson"];
  plugin.workspace = { x: -1_920, y: 0, width: 3_840, height: 1_080 };
  plugin.windowsStateJson = async () =>
    JSON.stringify({
      windows: plugin.windows,
      targetWindowId: plugin.targetWindowId,
      workspace: plugin.workspace,
      outputs: outputs ?? [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: 0, width: 1_920, height: 1_080 },
      ],
      locked: false,
    });
  plugin.windows = [
    {
      id: "right-window",
      title: "Editor",
      appName: "org.kde.kate",
      pid: 7,
      bounds: { x: 200, y: 100, width: 800, height: 600 },
      focused: false,
      minimized: false,
      visible: true,
    },
  ];
}

describe("observation scope on a multi-monitor desktop", () => {
  it("names the monitor holding the agent's target window, in agent space", async () => {
    const plugin = new FakePlugin();
    twoMonitors(plugin);
    plugin.targetWindowId = "right-window";
    const backend = makeBackend(plugin);
    await backend.availability();
    await expect(backend.defaultObservationRegion()).resolves.toEqual({
      x: 1_920,
      y: 0,
      width: 1_920,
      height: 1_080,
    });
  });

  it("falls back to the monitor under the agent's cursor", async () => {
    const plugin = new FakePlugin();
    twoMonitors(plugin);
    plugin.targetWindowId = null;
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    await backend.availability();
    await backend.moveCursor({ x: 300, y: 300 });
    await expect(backend.defaultObservationRegion()).resolves.toEqual({
      x: 0,
      y: 0,
      width: 1_920,
      height: 1_080,
    });
  });

  it("scopes getState's own screenshot the same way", async () => {
    const plugin = new FakePlugin();
    twoMonitors(plugin);
    plugin.targetWindowId = "right-window";
    const backend = makeBackend(plugin);
    await backend.availability();
    const state = await backend.getState({ includeScreenshot: true });
    expect(plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 1_920, 1_080, 1_536],
    });
    expect(state.screenshot?.region).toEqual({ x: 1_920, y: 0, width: 1_920, height: 1_080 });
  });

  it("keeps the whole workspace on one screen or a plugin that reports no monitors", async () => {
    const single = new FakePlugin();
    twoMonitors(single, [{ x: -1_920, y: 0, width: 3_840, height: 1_080 }]);
    const one = makeBackend(single);
    await one.availability();
    await expect(one.defaultObservationRegion()).resolves.toBeUndefined();

    const old = makeBackend(new FakePlugin());
    await old.availability();
    await expect(old.defaultObservationRegion()).resolves.toBeUndefined();
  });
});
