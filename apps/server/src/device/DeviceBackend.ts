/** one interface, one implementation per device platform (iOS simulator today); promise-shaped so the fake backend and every manager test are trivial to drive */
import type {
  DeviceAvailability,
  DeviceGeometry,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceKeyModifier,
  DeviceLaunchAppResult,
  DevicePlatform,
  DeviceScreenshotResult,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
} from "@synara/contracts";

/** `sequence` is backend-owned, per device, monotonic — the transport detects gaps without re-deriving them; `codecConfig` marks parameter sets a late subscriber needs before any keyframe decodes */
export interface DeviceStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export type DeviceFrameListener = (frame: DeviceStreamFrame) => void;

/** `retryable` separates transient trouble (device still booting) from permanent refusal so the manager decides whether to keep the attachment */
export class DeviceBackendError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeviceBackendError";
    this.retryable = options?.retryable ?? false;
  }
}

export interface DeviceListOptions {
  readonly includeShutdown?: boolean;
}

export interface DeviceSwipeGesture {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
}

export interface DeviceKeyEvent {
  readonly keyCode: number;
  readonly modifiers: readonly DeviceKeyModifier[];
  readonly direction: "down" | "up";
}

export interface DeviceBackend {
  readonly platform: DevicePlatform;

  /** cheap enough to call on every list; backends cache their own probes */
  availability(): Promise<DeviceAvailability>;

  /** `bootSource` always reported "user" — the backend can't know who asked; the manager overrides it for devices it booted */
  listDevices(options?: DeviceListOptions): Promise<readonly DeviceDescriptor[]>;

  boot(udid: string): Promise<DeviceDescriptor>;
  shutdown(udid: string): Promise<void>;

  install(udid: string, appPath: string): Promise<DeviceInstallAppResult>;
  launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
  ): Promise<DeviceLaunchAppResult>;
  openUrl(udid: string, url: string): Promise<void>;

  tap(udid: string, x: number, y: number): Promise<void>;
  swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void>;
  typeText(udid: string, text: string): Promise<void>;
  keyEvent(udid: string, event: DeviceKeyEvent): Promise<void>;
  pressButton(udid: string, button: DeviceHardwareButton): Promise<void>;

  screenshot(udid: string, options?: { readonly save?: boolean }): Promise<DeviceScreenshotResult>;
  startRecording(udid: string): Promise<DeviceStartRecordingResult>;
  stopRecording(udid: string): Promise<DeviceStopRecordingResult>;
  describeUi(udid: string): Promise<DeviceDescribeUiResult>;

  /** calling twice for the same udid replaces the listener rather than starting a second capture */
  /** null until something has attached — the values come from the helper, not discovery */
  geometry(udid: string): DeviceGeometry | null;

  attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void>;
  detachStream(udid: string): Promise<void>;

  dispose(): Promise<void>;
}
