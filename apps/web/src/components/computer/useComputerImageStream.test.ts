import type { ComputerId } from "@synara/contracts";
import type { ComputerFrame } from "@synara/shared/computerFrame";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mergeComputerImageStreamStatus, useComputerImageStream } from "./useComputerImageStream";

describe("mergeComputerImageStreamStatus", () => {
  it("keeps the previous object when a frame reports streaming again", () => {
    const previous = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "streaming" })).toBe(previous);
  });

  it("returns the next status when the kind changes", () => {
    const next = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus({ kind: "connecting" }, next)).toBe(next);
  });

  it("keeps the previous error while the message is unchanged, and swaps when it differs", () => {
    const previous = { kind: "error", message: "boom" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "error", message: "boom" })).toBe(
      previous,
    );

    const next = { kind: "error", message: "different" } as const;
    expect(mergeComputerImageStreamStatus(previous, next)).toBe(next);
  });
});

// Hook coverage for the disable-path ownership guard: the stills stream shares
// its canvas with the preview tap, so disabling it must not wipe pixels it
// never drew. Uses the same slot-tracked React harness as
// useComputerPreviewTap.test.ts, with the frame source stubbed to capture its
// handlers so frames can be fed without a WebSocket.

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

const frameSourceHarness = vi.hoisted(() => ({
  handlers: null as {
    onFrame: (frame: ComputerFrame) => void;
    onReset: (reason: string) => void;
  } | null,
  close: vi.fn(),
  requestResync: vi.fn(),
}));

vi.mock("~/lib/computerFrameSource", () => ({
  createComputerFrameSource: (options: {
    handlers: {
      onFrame: (frame: ComputerFrame) => void;
      onReset: (reason: string) => void;
    };
  }) => {
    frameSourceHarness.handlers = options.handlers;
    return {
      requestResync: frameSourceHarness.requestResync,
      close: frameSourceHarness.close,
    };
  },
}));

const COMPUTER_ID = "desktop" as ComputerId;

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

function feedSequence(sequence: number): void {
  frameSourceHarness.handlers?.onFrame({
    header: { computerId: COMPUTER_ID, sequence },
    payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  } as unknown as ComputerFrame);
}

/** The PNG decode awaits a mocked createImageBitmap; a few microtask turns settle it. */
async function flushDecode(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function renderStream(input: {
  enabled: boolean;
  computerId?: ComputerId | null;
  canvasRef?: { current: unknown };
}) {
  reactHarness.beginRender();
  return useComputerImageStream({
    canvasRef: (input.canvasRef ?? { current: null }) as React.RefObject<HTMLCanvasElement | null>,
    computerId: input.computerId ?? COMPUTER_ID,
    enabled: input.enabled,
  });
}

function stubVisibleDocument(): void {
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

const createImageBitmapMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  reactHarness.reset();
  frameSourceHarness.handlers = null;
  frameSourceHarness.close.mockClear();
  frameSourceHarness.requestResync.mockClear();
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

describe("useComputerImageStream disable path", () => {
  it("leaves a canvas it never drew alone when disabled", () => {
    const { context, canvasRef } = createCanvas();

    // The handoff shape: the stream was enabled while the tap owned the
    // canvas, so no stills frame ever decoded before the tap took over.
    renderStream({ enabled: true, canvasRef });
    renderStream({ enabled: false, canvasRef });

    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it("clears the canvas it drew once disabled", async () => {
    const { canvas, context, canvasRef } = createCanvas();

    renderStream({ enabled: true, canvasRef });
    feedSequence(1);
    await flushDecode();

    expect(createImageBitmapMock).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(200);
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(renderStream({ enabled: true, canvasRef }).dimensions).toEqual({
      width: 320,
      height: 200,
    });

    renderStream({ enabled: false, canvasRef });
    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    expect(context.clearRect).toHaveBeenCalledOnce();
  });
});
