/**
 * DeviceBackend - platform abstraction behind the device pane.
 *
 * One interface, one implementation per device platform. The iOS simulator
 * backend is the only one today; the contracts and this interface are written
 * so an Android emulator backend can be added without touching the manager,
 * the WebSocket surface, or the MCP tools.
 *
 * Backends speak plain promises rather than Effect: they are thin adapters over
 * subprocesses and sockets, and keeping them promise-shaped makes the fake
 * backend (and therefore every manager test) trivial to drive.
 *
 * @module device/DeviceBackend
 */
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
import { DEVICE_MESSAGE_MAX_LENGTH } from "@synara/contracts";

/**
 * One encoded video frame as the backend produces it. `sequence` is owned by
 * the backend (per device, monotonic) so the transport can detect gaps without
 * re-deriving them, and `codecConfig` marks parameter sets that a late
 * subscriber must receive before any keyframe decodes.
 */
export interface DeviceStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export type DeviceFrameListener = (frame: DeviceStreamFrame) => void;

/**
 * Shorten a message to what the device contract accepts.
 *
 * Errors can carry a whole compiler or simctl stderr, which easily runs past
 * the contract's limit, and a value past the limit fails the RPC encode, so the
 * pane would get a generic RPC failure instead of the error. Keeps the start
 * (what failed) and the end (the last diagnostics and the suggested fix).
 */
export function fitDeviceMessage(message: string): string {
  if (message.length <= DEVICE_MESSAGE_MAX_LENGTH) return message;
  const separator = "\n…\n";
  const keep = DEVICE_MESSAGE_MAX_LENGTH - separator.length;
  const head = Math.ceil(keep / 2);
  return `${message.slice(0, head)}${separator}${message.slice(message.length - (keep - head))}`;
}

/**
 * Failure surfaced to the pane as `ThreadDeviceState.lastError`. `retryable`
 * separates transient trouble (device still booting) from a permanent refusal
 * (no such device), so the manager can decide whether to keep the attachment.
 */
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

/** The screen edge a gesture starts on; iOS reads it as the OS edge gesture. */
export type DeviceTouchEdge = "top" | "left" | "bottom" | "right";

export interface DeviceSwipeGesture {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly durationMs: number;
  /** Set for a swipe that starts on an edge: back, notification shade, home, Control Center. */
  readonly edge?: DeviceTouchEdge | undefined;
}

export type DeviceScreenshotCapture = DeviceScreenshotResult & {
  readonly proofBytesBase64?: string;
};

export interface DeviceTypeTextOutcome {
  /** Characters with no key on the keyboard, which were not typed. */
  readonly skipped: number;
}

export interface DeviceLaunchOptions {
  /** Kill a running copy first, so the launch starts from a cold process. */
  readonly terminateExisting?: boolean | undefined;
  /** Environment for the app process (passed as `SIMCTL_CHILD_*`). */
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

/** One environment change; see `DeviceBackend.configure`. */
export type DeviceConfiguration =
  | { readonly kind: "appearance"; readonly appearance: "light" | "dark" }
  | { readonly kind: "content-size"; readonly category: string }
  | { readonly kind: "location"; readonly latitude: number; readonly longitude: number }
  | { readonly kind: "location-clear" }
  | {
      readonly kind: "privacy";
      readonly action: "grant" | "revoke" | "reset";
      readonly service: string;
      readonly bundleId?: string | undefined;
    };

export interface DeviceLogQuery {
  readonly bundleId: string;
  /** How far back to read, in seconds. */
  readonly sinceSeconds: number;
  /** Lowest unified-log level to include. */
  readonly level: "error" | "default" | "info" | "debug";
  /** Case-insensitive substring every returned line must contain. */
  readonly contains?: string | undefined;
  /** Newest lines kept when there are more. */
  readonly limit: number;
}

export interface DeviceCrashReport {
  readonly path: string;
  readonly capturedAt: string;
  /** e.g. `EXC_BAD_ACCESS (SIGSEGV)` or `EXC_CRASH (SIGABRT)`, when parseable. */
  readonly exception: string | null;
  /** Abort/assertion text or termination reason, when the report carries one. */
  readonly reason: string | null;
}

export interface DeviceLogResult {
  readonly bundleId: string;
  readonly process: string | null;
  /** Unified log (os_log, Logger, NSLog) for the app's process. */
  readonly log: readonly string[];
  /** stdout/stderr (`print`) of the last launch through Synara, when captured. */
  readonly console: readonly string[];
  readonly consoleUnavailableReason?: string;
  readonly crashes: readonly DeviceCrashReport[];
  /** Lines dropped by `limit`, across both streams. */
  readonly omitted: number;
}

export interface DeviceKeyEvent {
  readonly keyCode: number;
  readonly modifiers: readonly DeviceKeyModifier[];
  readonly direction: "down" | "up";
}

export interface DeviceBackend {
  readonly platform: DevicePlatform;

  /**
   * Whether the pane can run at all, and which setup steps remain. Cheap enough
   * to call on every list; backends cache their own probes.
   */
  availability(): Promise<DeviceAvailability>;

  /**
   * Discovered devices. `bootSource` is always reported as `"user"` here: the
   * backend cannot know who asked for a boot, so the manager overrides the
   * field for devices it booted itself.
   */
  listDevices(options?: DeviceListOptions): Promise<readonly DeviceDescriptor[]>;

  boot(udid: string): Promise<DeviceDescriptor>;
  shutdown(udid: string): Promise<void>;

  install(udid: string, appPath: string): Promise<DeviceInstallAppResult>;
  launch(
    udid: string,
    bundleId: string,
    launchArguments?: readonly string[],
    options?: DeviceLaunchOptions,
  ): Promise<DeviceLaunchAppResult>;
  openUrl(udid: string, url: string): Promise<void>;

  /** `holdMs` above ~500 is a long press. */
  tap(udid: string, x: number, y: number, options?: { readonly holdMs?: number }): Promise<void>;
  swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void>;
  /**
   * Keystrokes through HID. Only printable ASCII has a key, and the guest
   * resolves keys through its own hardware keyboard layout, so callers that
   * need exact text check `usesUsKeyboardLayout` or use `setFocusedValue`.
   */
  typeText(
    udid: string,
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DeviceTypeTextOutcome>;
  /**
   * Replace the focused element's value through accessibility: any Unicode,
   * independent of keyboard layout, one change event instead of keystrokes.
   */
  setFocusedValue(udid: string, value: string): Promise<void>;
  /** Whether HID keystrokes produce the characters their US key caps show. */
  usesUsKeyboardLayout(udid: string): Promise<boolean>;
  keyEvent(udid: string, event: DeviceKeyEvent): Promise<void>;
  pressButton(udid: string, button: DeviceHardwareButton): Promise<void>;

  /**
   * `save` writes the PNG beside recordings and reports its path. `resolution:
   * "points"` scales the image to the screen's point size, so an image
   * coordinate is the device point a tap would take.
   */
  screenshot(
    udid: string,
    options?: {
      readonly save?: boolean;
      readonly maxInlineBytes?: number;
      readonly resolution?: "pixels" | "points";
      readonly proof?: boolean;
    },
  ): Promise<DeviceScreenshotCapture>;
  startRecording(udid: string): Promise<DeviceStartRecordingResult>;
  stopRecording(udid: string): Promise<DeviceStopRecordingResult>;
  describeUi(udid: string): Promise<DeviceDescribeUiResult>;

  /** Change one piece of simulator state an E2E test needs to control. */
  configure(udid: string, configuration: DeviceConfiguration): Promise<void>;
  /** Recent logs and crash reports for one app. */
  readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult>;

  /**
   * Begin (or join) the encoded video stream for a device. Calling twice for
   * the same udid replaces the listener rather than starting a second capture.
   */
  /**
   * Screen geometry for a device, when the backend knows it. Null until
   * something has attached to the device, since the values come from the
   * native helper rather than from discovery.
   */
  geometry(udid: string): DeviceGeometry | null;

  attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void>;
  detachStream(udid: string): Promise<void>;

  /**
   * Called when a running stream ends without being detached (the helper
   * process died). Optional: a backend that cannot lose its stream need not
   * implement it. Returns an unsubscribe.
   */
  onStreamInterrupted?(listener: (udid: string, reason: string) => void): () => void;

  /** Release every process, socket, and timer the backend owns. */
  dispose(): Promise<void>;
}
