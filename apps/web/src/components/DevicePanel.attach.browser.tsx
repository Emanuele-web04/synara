import "../index.css";

import {
  ThreadId,
  type DeviceDescriptor,
  type DeviceUdid,
  type ThreadDeviceState,
} from "@synara/contracts";
import type { DeviceFrame } from "@synara/shared/deviceFrame";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { DeviceFrameSourceOptions } from "~/lib/deviceFrameSource";

const transport = vi.hoisted(() => ({
  sources: [] as Array<DeviceFrameSourceOptions & { close: ReturnType<typeof vi.fn> }>,
  getThreadState: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ device: { getThreadState: transport.getThreadState } }),
}));
vi.mock("~/lib/deviceFrameSource", () => ({
  createDeviceFrameSource: (options: DeviceFrameSourceOptions) => {
    const close = vi.fn();
    transport.sources.push({ ...options, close });
    return { close, requestResync: vi.fn() };
  },
}));

import { useDeviceStateStore } from "~/deviceStateStore";
import DevicePanel from "./DevicePanel";

const THREAD = ThreadId.makeUnsafe("simulator-attach-race");
const SLIM = "11111111-1111-1111-1111-111111111111" as DeviceUdid;
const SLIM_2 = "22222222-2222-2222-2222-222222222222" as DeviceUdid;
const devices: DeviceDescriptor[] = [SLIM, SLIM_2].map((udid, index) => ({
  udid,
  platform: "ios-simulator",
  name: index === 0 ? "iOS 27 Slim" : "iOS 27 Slim 2",
  runtime: "iOS 27.0",
  state: "booted",
  bootSource: index === 0 ? "user" : "synara",
  geometry: { pointWidth: 402, pointHeight: 874, scale: 3 },
}));

function state(
  udid = SLIM_2,
  version = 1,
  attachPhase: ThreadDeviceState["attachPhase"] = "connecting",
): ThreadDeviceState {
  return {
    threadId: THREAD,
    version,
    attachedDeviceUdid: udid,
    attachPhase,
    devices,
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
  };
}

// decode timing is controlled but paint uses a real VideoFrame + canvas — no native simulator or platform codec needed to exercise this UI race
const decoders: ControlledDecoder[] = [];
class ControlledDecoder {
  state = "unconfigured";
  constructor(readonly callbacks: VideoDecoderInit) {
    decoders.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode() {
    this.paint();
  }
  close() {
    this.state = "closed";
  }
  paint() {
    const surface = document.createElement("canvas");
    surface.width = 40;
    surface.height = 80;
    const context = surface.getContext("2d")!;
    context.fillStyle = "#22c55e";
    context.fillRect(0, 0, 40, 80);
    this.callbacks.output(new VideoFrame(surface, { timestamp: 0 }));
  }
}

function frame(udid: DeviceUdid, codecConfig: boolean): DeviceFrame {
  return {
    header: {
      deviceId: udid,
      sequence: codecConfig ? 1 : 2,
      timestampMs: 0,
      codecConfig,
      keyframe: !codecConfig,
    },
    payload: codecConfig ? new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]) : new Uint8Array([1]),
  };
}

function prime(source: DeviceFrameSourceOptions, udid = source.udid) {
  source.handlers.onFrame(frame(udid, true));
  source.handlers.onFrame(frame(udid, false));
}

let unmount: (() => Promise<void>) | undefined;
beforeEach(() => {
  useDeviceStateStore.getState().clear();
  transport.sources.length = 0;
  decoders.length = 0;
  vi.stubGlobal("VideoDecoder", ControlledDecoder);
  transport.getThreadState.mockImplementation(async () => state());
});
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  useDeviceStateStore.getState().clear();
});

async function mount(initial = state()) {
  useDeviceStateStore.getState().upsertThreadState(initial);
  transport.getThreadState.mockResolvedValue(initial);
  const mounted = await render(
    <div style={{ width: 420, height: 700 }}>
      <DevicePanel
        mode="sidebar"
        threadId={THREAD}
        runtimeMode="live"
        isVisible
        onClosePanel={() => {}}
      />
    </div>,
  );
  unmount = mounted.unmount;
  await expect.poll(() => transport.sources.length).toBe(1);
  return mounted;
}

describe("simulator attach first frame", () => {
  it.each(["connecting", "waiting-for-display"] as const)(
    "paints the first frame before %s metadata clears",
    async (phase) => {
      const mounted = await mount(state(SLIM_2, 1, phase));
      prime(transport.sources[0]!);
      // The native helper primes once; an idle screen sends no later damage frames.
      useDeviceStateStore.getState().upsertThreadState(state(SLIM_2, 2, null));
      await expect.poll(() => document.querySelector("canvas")?.width).toBe(40);
      await expect
        .element(mounted.getByText("Connecting…", { exact: true }))
        .not.toBeInTheDocument();
      const pixel = document
        .querySelector("canvas")!
        .getContext("2d")!
        .getImageData(0, 0, 1, 1).data;
      expect(Array.from(pixel)).toEqual([34, 197, 94, 255]);
    },
  );

  it("switches by UDID and ignores late frames from the other booted Slim", async () => {
    await mount(state(SLIM));
    const first = transport.sources[0]!;
    prime(first);
    useDeviceStateStore.getState().upsertThreadState(state(SLIM_2, 2));
    await expect.poll(() => transport.sources.length).toBe(2);
    const second = transport.sources[1]!;
    expect(second.udid).toBe(SLIM_2);
    expect(first.close).toHaveBeenCalledOnce();
    const count = decoders.length;
    prime(first);
    prime(second, SLIM);
    expect(decoders).toHaveLength(count);
    prime(second);
    await expect.poll(() => document.querySelector("canvas")?.width).toBe(40);
    expect(document.querySelector("canvas")?.getAttribute("aria-label")).toBe(
      "iOS 27 Slim 2 screen",
    );
  });

  it("shows decoder errors even while attach metadata still says connecting", async () => {
    const mounted = await mount();
    transport.sources[0]!.handlers.onFrame(frame(SLIM_2, true));
    decoders[0]!.callbacks.error(new DOMException("Simulator decoder failed"));
    await expect
      .element(mounted.getByText("Simulator decoder failed", { exact: true }))
      .toBeVisible();
  });
});
