// FILE: useComputerPreviewTap.test.ts
// Purpose: Characterize the native preview tap hook: bridge subscription,
//          seq gating, single in-flight decode, the ~1s activity window, and
//          cleanup so the stills stream can share the same canvas.
// Layer: Web hook test
//
// Uses the same minimal React harness as useBrowserPanelDesktopBridge.test.ts:
// effects run through slot-tracked useEffect/useState/useRef doubles, so the
// hook can be driven and inspected without a DOM. The desktop bridge is a
// plain mocked object under a stubbed `window`, matching real Electron
// delivery where frames arrive as {windowId, seq, jpeg} payloads.

import type { DesktopComputerPreviewFrame, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface EffectSlot {
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    value?: unknown;
    setter?: (...args: never[]) => void;
    refObj?: { current: unknown };
  }

  let slots: EffectSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
      const slot = nextSlot();
      if (slot.setter === undefined) {
        slot.value = typeof initial === "function" ? (initial as () => T)() : initial;
        slot.setter = (value: T | ((previous: T) => T)) => {
          slot.value =
            typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value;
        };
      }
      return [slot.value as T, slot.setter as (value: T | ((previous: T) => T)) => void];
    },
    useRef<T>(initial: T): { current: T } {
      const slot = nextSlot();
      slot.refObj ??= { current: initial };
      return slot.refObj as { current: T };
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

import { COMPUTER_PREVIEW_TAP_QUIET_MS, useComputerPreviewTap } from "./useComputerPreviewTap";

const THREAD_ID = "thread-tap" as ThreadId;

interface FakeCanvas {
  canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
  };
  context: {
    drawImage: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
  };
  canvasRef: { current: unknown };
}

function createCanvas(): FakeCanvas {
  const context = { drawImage: vi.fn(), clearRect: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  return { canvas, context, canvasRef: { current: canvas } };
}

interface BridgeHarness {
  listener: ((frame: DesktopComputerPreviewFrame) => void) | null;
  unsubscribe: ReturnType<typeof vi.fn>;
  onFrame: ReturnType<typeof vi.fn>;
}

function createBridge(): BridgeHarness {
  const harness: BridgeHarness = {
    listener: null,
    unsubscribe: vi.fn(),
    onFrame: vi.fn(),
  };
  harness.onFrame.mockImplementation((listener: (frame: DesktopComputerPreviewFrame) => void) => {
    harness.listener = listener;
    return harness.unsubscribe;
  });
  return harness;
}

function feed(bridge: BridgeHarness, seq: number): void {
  bridge.listener?.({ windowId: 7, seq, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
}

/** The JPEG decode awaits a mocked createImageBitmap; a few microtask turns settle it. */
async function flushDecode(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function render(input: {
  enabled: boolean;
  canvasRef?: { current: unknown };
  threadId?: ThreadId;
}) {
  reactHarness.beginRender();
  return useComputerPreviewTap({
    canvasRef: (input.canvasRef ?? { current: null }) as React.RefObject<HTMLCanvasElement | null>,
    threadId: input.threadId,
    enabled: input.enabled,
  });
}

function stubVisibleDocument(): { visibilityState: string; listener: (() => void) | null } {
  const doc = {
    visibilityState: "visible",
    listener: null as (() => void) | null,
    addEventListener: vi.fn((_type: string, update: () => void) => {
      doc.listener = update;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("document", doc);
  return doc;
}

const createImageBitmapMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  reactHarness.reset();
  vi.unstubAllGlobals();
  createImageBitmapMock.mockReset();
  createImageBitmapMock.mockImplementation(async () => ({
    width: 320,
    height: 200,
    close: vi.fn(),
  }));
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  stubVisibleDocument();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useComputerPreviewTap", () => {
  it("stays inert without the desktop bridge, exactly like a plain browser", () => {
    vi.stubGlobal("window", {});
    const output = render({ enabled: true });
    expect(output.active).toBe(false);
  });

  it("does not subscribe while disabled", () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });

    render({ enabled: false });
    expect(bridge.onFrame).not.toHaveBeenCalled();
  });

  it("decodes frames into the canvas and reports active", async () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { canvas, context, canvasRef } = createCanvas();

    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(false);
    feed(bridge, 1);
    await flushDecode();

    expect(createImageBitmapMock).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(200);
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(true);
  });

  it("drops stale and repeated seq frames without decoding them", async () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { context, canvasRef } = createCanvas();

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    feed(bridge, 1);
    await flushDecode();
    feed(bridge, 3);
    await flushDecode();
    feed(bridge, 2); // stale: behind the last decoded seq
    feed(bridge, 3); // repeat: never decode the same frame twice
    feed(bridge, 4);
    await flushDecode();

    expect(createImageBitmapMock).toHaveBeenCalledTimes(3);
    expect(context.drawImage).toHaveBeenCalledTimes(3);
  });

  it("keeps one pending decode and drops rather than queues", async () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { context, canvasRef } = createCanvas();

    const deferred = {} as { resolve: (bitmap: unknown) => void };
    createImageBitmapMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    feed(bridge, 1);
    // Frames arriving mid-decode must be dropped, never queued for later.
    feed(bridge, 2);
    feed(bridge, 3);
    deferred.resolve({ width: 320, height: 200, close: vi.fn() });
    await flushDecode();
    feed(bridge, 4);
    await flushDecode();

    // Only seq 1 and seq 4 ever decoded; 2 and 3 were dropped while busy.
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
  });

  it("goes quiet after the tap window and wakes on the next frame", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { canvasRef } = createCanvas();

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    feed(bridge, 1);
    await vi.advanceTimersByTimeAsync(0);
    await flushDecode();
    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(true);

    vi.advanceTimersByTime(COMPUTER_PREVIEW_TAP_QUIET_MS + 1);
    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(false);

    feed(bridge, 2);
    await vi.advanceTimersByTimeAsync(0);
    await flushDecode();
    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(true);
  });

  it("unsubscribes and clears the canvas it drew on disable", async () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { context, canvasRef } = createCanvas();

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    feed(bridge, 1);
    await flushDecode();

    render({ enabled: false, canvasRef, threadId: THREAD_ID });
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(render({ enabled: false, canvasRef, threadId: THREAD_ID }).active).toBe(false);
  });

  it("leaves a canvas it never drew on alone", () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { context, canvasRef } = createCanvas();

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    render({ enabled: false, canvasRef, threadId: THREAD_ID });

    // No frame ever decoded, so the stills stream owns the canvas content:
    // the tap must not wipe another drawer's pixels on its way out.
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it("unsubscribes while the page is hidden and resubscribes on return", async () => {
    const bridge = createBridge();
    vi.stubGlobal("window", { desktopBridge: { computerPreview: { onFrame: bridge.onFrame } } });
    const { canvasRef } = createCanvas();
    const doc = stubVisibleDocument();

    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    expect(bridge.onFrame).toHaveBeenCalledOnce();

    doc.visibilityState = "hidden";
    doc.listener?.();
    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
    expect(bridge.onFrame).toHaveBeenCalledOnce();

    doc.visibilityState = "visible";
    doc.listener?.();
    render({ enabled: true, canvasRef, threadId: THREAD_ID });
    expect(bridge.onFrame).toHaveBeenCalledTimes(2);
    feed(bridge, 1);
    await flushDecode();
    expect(render({ enabled: true, canvasRef, threadId: THREAD_ID }).active).toBe(true);
  });
});
