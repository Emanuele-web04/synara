/** deterministic in-memory backend: every effect recorded, every clock injectable — manager lifecycle, tool, and transport tests run on any platform without Xcode */
import { tmpdir } from "node:os";
import * as path from "node:path";

import type {
  DeviceAvailability,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceLaunchAppResult,
  DeviceScreenshotResult,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
} from "@synara/contracts";

import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceListOptions,
  type DeviceStreamFrame,
  type DeviceSwipeGesture,
} from "./DeviceBackend.ts";

export interface FakeDeviceSeed {
  readonly udid: string;
  readonly name: string;
  readonly runtime: string;
  readonly state?: DeviceDescriptor["state"];
}

export type FakeDeviceCall =
  | { readonly kind: "boot"; readonly udid: string }
  | { readonly kind: "shutdown"; readonly udid: string }
  | { readonly kind: "install"; readonly udid: string; readonly appPath: string }
  | { readonly kind: "launch"; readonly udid: string; readonly bundleId: string }
  | { readonly kind: "openUrl"; readonly udid: string; readonly url: string }
  | { readonly kind: "tap"; readonly udid: string; readonly x: number; readonly y: number }
  | { readonly kind: "swipe"; readonly udid: string; readonly gesture: DeviceSwipeGesture }
  | { readonly kind: "typeText"; readonly udid: string; readonly text: string }
  | { readonly kind: "keyEvent"; readonly udid: string; readonly event: DeviceKeyEvent }
  | { readonly kind: "pressButton"; readonly udid: string; readonly button: DeviceHardwareButton }
  | { readonly kind: "screenshot"; readonly udid: string }
  | { readonly kind: "startRecording"; readonly udid: string }
  | { readonly kind: "stopRecording"; readonly udid: string }
  | { readonly kind: "describeUi"; readonly udid: string }
  | { readonly kind: "attachStream"; readonly udid: string }
  | { readonly kind: "detachStream"; readonly udid: string };

export interface FakeDeviceBackendOptions {
  readonly devices?: readonly FakeDeviceSeed[];
  readonly availability?: DeviceAvailability;
  readonly now?: () => number;
}

/** iPhone 17 Pro geometry — the shape that exposed the pixel-vs-point bug */
export const DEFAULT_FAKE_GEOMETRY: DeviceGeometry = {
  pointWidth: 402,
  pointHeight: 874,
  scale: 3,
};

const DEFAULT_DEVICES: readonly FakeDeviceSeed[] = [
  { udid: "FAKE-0001", name: "iPhone 17 Pro", runtime: "iOS 26.0", state: "shutdown" },
  { udid: "FAKE-0002", name: "iPhone 17", runtime: "iOS 26.0", state: "shutdown" },
  { udid: "FAKE-0003", name: "iPad Pro 13-inch", runtime: "iOS 26.0", state: "shutdown" },
  { udid: "FAKE-0004", name: "iPhone Air", runtime: "iOS 26.0", state: "shutdown" },
];

// a 1x1 transparent PNG — valid enough that decoding it in a test gets a real image
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** far enough below the 852pt screen to need several swipes */
const FAKE_DEEP_ROW_START_Y = 2_400;

/** the list's end — past this the deep row stops moving */
const FAKE_MAX_SCROLL_OFFSET = 2_000;

/** rows further down are not rendered yet, as UIKit virtualizes them */
const FAKE_VIRTUALIZATION_HORIZON = 1_600;

export class FakeDeviceBackend implements DeviceBackend {
  readonly platform = "ios-simulator" as const;

  readonly calls: FakeDeviceCall[] = [];
  /** set by tests to make the next call of a kind reject */
  readonly failures = new Map<FakeDeviceCall["kind"], DeviceBackendError>();
  disposed = false;

  private availabilityValue: DeviceAvailability;
  /** how far the fake list has scrolled, in device points */
  private scrollOffset = 0;
  private readonly now: () => number;
  private readonly devices = new Map<string, DeviceDescriptor>();
  private readonly listeners = new Map<string, DeviceFrameListener>();
  private nextStreamFailure: string | null = null;
  private persistentStreamFailure: string | null = null;
  private readonly sequences = new Map<string, number>();
  private readonly installedBundles = new Map<string, string>();
  private readonly attachedGeometry = new Set<string>();
  private readonly recordings = new Map<
    string,
    { readonly path: string; readonly startedAt: string }
  >();

  constructor(options: FakeDeviceBackendOptions = {}) {
    this.availabilityValue = options.availability ?? { kind: "available" };
    this.now = options.now ?? Date.now;
    for (const seed of options.devices ?? DEFAULT_DEVICES) {
      this.devices.set(seed.udid, {
        platform: "ios-simulator",
        udid: seed.udid,
        name: seed.name,
        runtime: seed.runtime,
        state: seed.state ?? "shutdown",
        bootSource: "user",
      });
    }
  }

  setAvailability(availability: DeviceAvailability): void {
    this.availabilityValue = availability;
  }

  failNext(kind: FakeDeviceCall["kind"], error: DeviceBackendError): void {
    this.failures.set(kind, error);
  }

  /** mark a device booted without going through Synara, as Simulator.app would */
  bootExternally(udid: string): void {
    const device = this.requireDevice(udid);
    this.devices.set(udid, { ...device, state: "booted", bootSource: "user" });
  }

  /** stop a device behind Synara's back — the manager gets no notification, exactly the case that left a phantom holding a slot */
  shutdownExternally(udid: string): void {
    const device = this.requireDevice(udid);
    this.devices.set(udid, { ...device, state: "shutdown", bootSource: "user" });
    this.listeners.delete(udid);
  }

  hasStream(udid: string): boolean {
    return this.listeners.has(udid);
  }

  /** push one frame to whoever is attached; no-op when nobody listens */
  emitFrame(
    udid: string,
    frame: Partial<Omit<DeviceStreamFrame, "data">> & { readonly data?: Uint8Array } = {},
  ): DeviceStreamFrame | null {
    const listener = this.listeners.get(udid);
    if (!listener) return null;
    const sequence = frame.sequence ?? (this.sequences.get(udid) ?? 0) + 1;
    this.sequences.set(udid, sequence);
    const emitted: DeviceStreamFrame = {
      sequence,
      timestampMs: frame.timestampMs ?? this.now(),
      keyframe: frame.keyframe ?? false,
      codecConfig: frame.codecConfig ?? false,
      data: frame.data ?? new Uint8Array([sequence & 0xff]),
    };
    listener(emitted);
    return emitted;
  }

  callsOfKind<K extends FakeDeviceCall["kind"]>(
    kind: K,
  ): ReadonlyArray<Extract<FakeDeviceCall, { kind: K }>> {
    return this.calls.filter(
      (call): call is Extract<FakeDeviceCall, { kind: K }> => call.kind === kind,
    );
  }

  availability(): Promise<DeviceAvailability> {
    return Promise.resolve(this.availabilityValue);
  }

  listDevices(options: DeviceListOptions = {}): Promise<readonly DeviceDescriptor[]> {
    const all = [...this.devices.values()];
    return Promise.resolve(
      options.includeShutdown === true ? all : all.filter((device) => device.state !== "shutdown"),
    );
  }

  async boot(udid: string): Promise<DeviceDescriptor> {
    this.record({ kind: "boot", udid });
    const device = this.requireDevice(udid);
    const booted: DeviceDescriptor = { ...device, state: "booted" };
    this.devices.set(udid, booted);
    return booted;
  }

  async shutdown(udid: string): Promise<void> {
    this.record({ kind: "shutdown", udid });
    const device = this.requireDevice(udid);
    this.devices.set(udid, { ...device, state: "shutdown", bootSource: "user" });
    await this.detachStream(udid);
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    this.record({ kind: "install", udid, appPath });
    this.requireBooted(udid);
    const bundleId = `com.example.${
      appPath
        .split("/")
        .pop()
        ?.replace(/\.app$/u, "") || "app"
    }`;
    this.installedBundles.set(`${udid}:${bundleId}`, appPath);
    return { udid, bundleId };
  }

  async launch(
    udid: string,
    bundleId: string,
    _launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult> {
    this.record({ kind: "launch", udid, bundleId });
    this.requireBooted(udid);
    return { udid, bundleId, pid: 4_242 };
  }

  async openUrl(udid: string, url: string): Promise<void> {
    this.record({ kind: "openUrl", udid, url });
    this.requireBooted(udid);
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    this.record({ kind: "tap", udid, x, y });
    this.requireBooted(udid);
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    this.record({ kind: "swipe", udid, gesture });
    this.requireBooted(udid);
    // content follows the finger — an upward swipe pulls lower rows up; clamped at the list's end
    const delta = gesture.toY - gesture.fromY;
    this.scrollOffset = Math.max(0, Math.min(FAKE_MAX_SCROLL_OFFSET, this.scrollOffset - delta));
  }

  /** where the deep row sits given how far the list scrolled */
  private deepRowY(): number {
    return FAKE_DEEP_ROW_START_Y - this.scrollOffset;
  }

  async typeText(udid: string, text: string): Promise<void> {
    this.record({ kind: "typeText", udid, text });
    this.requireBooted(udid);
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    this.record({ kind: "keyEvent", udid, event });
    this.requireBooted(udid);
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    this.record({ kind: "pressButton", udid, button });
    this.requireBooted(udid);
  }

  async screenshot(
    udid: string,
    options: { readonly save?: boolean } = {},
  ): Promise<DeviceScreenshotResult> {
    this.record({ kind: "screenshot", udid });
    const device = this.requireBooted(udid);
    return {
      // mirrors the real backend — a saved shot lands beside the recordings
      ...(options.save === true ? { path: path.join(tmpdir(), `simulator-${udid}.png`) } : {}),
      udid,
      name: `${device.name}.png`,
      mimeType: "image/png",
      width: 1,
      height: 1,
      sizeBytes: Buffer.from(PNG_BASE64, "base64").byteLength,
      bytesBase64: PNG_BASE64,
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    this.record({ kind: "startRecording", udid });
    const device = this.requireBooted(udid);
    if (this.recordings.has(udid)) {
      throw new DeviceBackendError(`Device ${udid} is already recording`);
    }
    const startedAt = new Date(this.now()).toISOString();
    const slug =
      device.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "device";
    const timestamp = startedAt.replace(/[:.]/gu, "-");
    const recording = {
      path: path.join(tmpdir(), `simulator-${slug}-${timestamp}.mp4`),
      startedAt,
    };
    this.recordings.set(udid, recording);
    return { udid, ...recording };
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    this.record({ kind: "stopRecording", udid });
    const recording = this.recordings.get(udid);
    if (!recording) throw new DeviceBackendError(`Device ${udid} is not recording`);
    this.recordings.delete(udid);
    const stoppedAtMs = this.now();
    return {
      udid,
      path: recording.path,
      sizeBytes: 1_024,
      durationMs: Math.max(0, stoppedAtMs - Date.parse(recording.startedAt)),
      stoppedAt: new Date(stoppedAtMs).toISOString(),
    };
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    this.record({ kind: "describeUi", udid });
    this.requireBooted(udid);
    return {
      udid,
      capturedAt: new Date(this.now()).toISOString(),
      root: {
        role: "Application",
        subrole: null,
        label: "Fake App",
        value: null,
        frame: { x: 0, y: 0, width: 393, height: 852 },
        activationPoint: null,
        children: [
          {
            role: "Button",
            subrole: null,
            label: "Continue",
            value: null,
            frame: { x: 24, y: 700, width: 345, height: 50 },
            activationPoint: { x: 196, y: 725 },
            children: [],
          },
          // a switch row's frame centre is dead space — only the activation point toggles it; mirrors real UIKit rows
          {
            role: "CheckBox",
            subrole: "Switch",
            label: "Fake Toggle",
            value: "0",
            frame: { x: 24, y: 200, width: 345, height: 44 },
            activationPoint: { x: 340, y: 222 },
            children: [],
          },
          // virtualized like a real UIKit list — absent from the tree until scrolling brings it near
          ...(this.deepRowY() <= FAKE_VIRTUALIZATION_HORIZON
            ? [
                {
                  role: "Button",
                  subrole: null,
                  label: "Deep Row",
                  value: null,
                  frame: { x: 24, y: this.deepRowY(), width: 345, height: 44 },
                  activationPoint: { x: 196, y: this.deepRowY() + 22 },
                  children: [],
                },
              ]
            : []),
        ],
      },
    };
  }

  geometry(udid: string): DeviceGeometry | null {
    // mirrors the real backend — geometry only exists once something attached
    return this.attachedGeometry.has(udid) ? DEFAULT_FAKE_GEOMETRY : null;
  }

  /** models the early-boot window where a device reports booted before publishing a display */
  failNextStream(message: string): void {
    this.nextStreamFailure = message;
  }

  /** models a device that boots but never publishes a display — what the attach deadline exists for */
  failEveryStream(message: string): void {
    this.persistentStreamFailure = message;
  }

  clearStreamFailures(): void {
    this.nextStreamFailure = null;
    this.persistentStreamFailure = null;
  }

  async attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void> {
    this.record({ kind: "attachStream", udid });
    if (this.persistentStreamFailure !== null) {
      throw new DeviceBackendError(this.persistentStreamFailure);
    }
    const failure = this.nextStreamFailure;
    if (failure !== null) {
      this.nextStreamFailure = null;
      throw new DeviceBackendError(failure);
    }
    this.requireBooted(udid);
    this.attachedGeometry.add(udid);
    this.listeners.set(udid, onFrame);
  }

  async detachStream(udid: string): Promise<void> {
    if (!this.listeners.has(udid)) return;
    this.record({ kind: "detachStream", udid });
    this.listeners.delete(udid);
  }

  async dispose(): Promise<void> {
    for (const udid of Array.from(this.recordings.keys())) {
      await this.stopRecording(udid).catch(() => undefined);
    }
    this.disposed = true;
    this.listeners.clear();
  }

  private record(call: FakeDeviceCall): void {
    const failure = this.failures.get(call.kind);
    if (failure) {
      this.failures.delete(call.kind);
      throw failure;
    }
    this.calls.push(call);
  }

  private requireDevice(udid: string): DeviceDescriptor {
    const device = this.devices.get(udid);
    if (!device) throw new DeviceBackendError(`Unknown device ${udid}`);
    return device;
  }

  private requireBooted(udid: string): DeviceDescriptor {
    const device = this.requireDevice(udid);
    if (device.state !== "booted") {
      throw new DeviceBackendError(`Device ${udid} is not booted`, { retryable: true });
    }
    return device;
  }
}
