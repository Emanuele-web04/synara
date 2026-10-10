import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const DEVICE_WS_METHODS = {
  list: "device.list",
  boot: "device.boot",
  shutdown: "device.shutdown",
  attach: "device.attach",
  detach: "device.detach",
  getThreadState: "device.getThreadState",
  tap: "device.tap",
  swipe: "device.swipe",
  typeText: "device.typeText",
  keyEvent: "device.keyEvent",
  pressButton: "device.pressButton",
  installApp: "device.installApp",
  launchApp: "device.launchApp",
  openUrl: "device.openUrl",
  screenshot: "device.screenshot",
  startRecording: "device.startRecording",
  stopRecording: "device.stopRecording",
  describeUi: "device.describeUi",
  scrollToElement: "device.scrollToElement",
  subscribeEvents: "device.subscribeEvents",
} as const;

// one channel carries every device push — a pane costs a single stream lease
export const DEVICE_WS_CHANNELS = {
  event: "device.event",
} as const;

const DEVICE_UDID_MAX_LENGTH = 128;
const DEVICE_TEXT_MAX_LENGTH = 4_096;
const DEVICE_PATH_MAX_LENGTH = 1_024;
const DEVICE_URL_MAX_LENGTH = 8_192;
const DEVICE_MESSAGE_MAX_LENGTH = 2_048;

/** charset widened so an Android emulator serial (`emulator-5554`) fits without a schema break */
export const DeviceUdid = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DEVICE_UDID_MAX_LENGTH),
).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
export type DeviceUdid = typeof DeviceUdid.Type;

export const DevicePlatform = Schema.Literals(["ios-simulator"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceRuntimeState = Schema.Literals([
  "shutdown",
  "booting",
  "booted",
  "shutting-down",
]);
export type DeviceRuntimeState = typeof DeviceRuntimeState.Type;

/** Synara only auto-shuts down devices it booted itself — user-started devices outlive the session */
export const DeviceBootSource = Schema.Literals(["synara", "user"]);
export type DeviceBootSource = typeof DeviceBootSource.Type;

/** from the device type's product family, not the name — "iPad" in every tablet name won't hold; optional so backends that can't read the profile still list devices */
export const DeviceFamily = Schema.Literals(["phone", "tablet"]);
export type DeviceFamily = typeof DeviceFamily.Type;

export const DeviceDescriptor = Schema.Struct({
  platform: DevicePlatform,
  udid: DeviceUdid,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  runtime: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  state: DeviceRuntimeState,
  bootSource: DeviceBootSource,
  family: Schema.optional(DeviceFamily),
  /** input coords are device points but video frames are pixels — a click without dividing by scale lands several times too large; populated at discovery so the pane draws the right chassis immediately */
  geometry: Schema.optional(
    Schema.Struct({
      pointWidth: Schema.Finite.check(Schema.isGreaterThan(0)),
      pointHeight: Schema.Finite.check(Schema.isGreaterThan(0)),
      scale: Schema.Finite.check(Schema.isGreaterThan(0)),
    }),
  ),
});
export type DeviceDescriptor = typeof DeviceDescriptor.Type;

export type DeviceGeometry = NonNullable<DeviceDescriptor["geometry"]>;

/** the pane says "device state" while the manager stores descriptors */
export const DeviceState = DeviceDescriptor;
export type DeviceState = DeviceDescriptor;

export const DeviceSetupStepId = Schema.Literals([
  "install-xcode",
  "accept-xcode-license",
  "select-xcode-command-line-tools",
  "install-ios-runtime",
  "build-device-helper",
]);
export type DeviceSetupStepId = typeof DeviceSetupStepId.Type;

export const DeviceSetupStep = Schema.Struct({
  id: DeviceSetupStepId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  done: Schema.Boolean,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type DeviceSetupStep = typeof DeviceSetupStep.Type;

/** each maps to private symbols Apple moves between Xcode releases — named individually so one broken capability doesn't kill the rest */
export const DeviceCapabilityId = Schema.Literals([
  "framebuffer",
  "hid",
  "accessibility",
  "encoder",
]);
export type DeviceCapabilityId = typeof DeviceCapabilityId.Type;

export const DeviceCapabilityStatus = Schema.Struct({
  id: DeviceCapabilityId,
  ok: Schema.Boolean,
  /** the private symbol that couldn't be resolved, when that's the cause */
  missingSymbol: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** a non-symbol failure (framework load, encoder refusal) */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type DeviceCapabilityStatus = typeof DeviceCapabilityStatus.Type;

/** the toolchain the capability report was measured against */
export const DeviceToolchain = Schema.Struct({
  xcodeVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  xcodeBuild: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  macOS: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type DeviceToolchain = typeof DeviceToolchain.Type;

/** modelled like AppSnap's permission states — the UI renders one instead of guessing from errors */
export const DeviceAvailability = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    /** optional so an older server answering only "available" still validates — absent means "no detail", not "nothing works" */
    capabilities: Schema.optional(
      Schema.Array(DeviceCapabilityStatus).check(Schema.isMaxLength(16)),
    ),
    toolchain: Schema.optional(DeviceToolchain),
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported-platform"),
    platform: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("setup-required"),
    steps: Schema.Array(DeviceSetupStep).check(Schema.isMaxLength(16)),
  }),
  /** distinct from setup-required: nothing to install, the pane opens, only broken capabilities refuse and name the Xcode that broke them */
  Schema.Struct({
    kind: Schema.Literal("degraded"),
    capabilities: Schema.Array(DeviceCapabilityStatus).check(Schema.isMaxLength(16)),
    toolchain: Schema.optional(DeviceToolchain),
  }),
  // the helper is compiled on demand against the user's Xcode — a compile/launch failure is a designed state, not a generic toast
  Schema.Struct({
    kind: Schema.Literal("helper-unavailable"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH)),
  }),
]);
export type DeviceAvailability = typeof DeviceAvailability.Type;

/** capabilities each operation depends on, for precise failures */
export const DEVICE_CAPABILITY_LABELS: Record<DeviceCapabilityId, string> = {
  framebuffer: "Screen capture",
  hid: "Touch and keyboard input",
  accessibility: "Accessibility inspection",
  encoder: "Video encoding",
};

/** a cold boot takes ~a minute and publishes its display seconds after reporting booted — phases name what the user waits on */
export const DeviceAttachPhase = Schema.Literals(["booting", "waiting-for-display", "connecting"]);
export type DeviceAttachPhase = typeof DeviceAttachPhase.Type;

export const ThreadDeviceState = Schema.Struct({
  threadId: ThreadId,
  /** monotonic per thread — lets the pane drop out-of-order pushes */
  version: NonNegativeInt,
  attachedDeviceUdid: Schema.NullOr(DeviceUdid),
  /** non-null with attachedDeviceUdid already set is normal — the intent is recorded first so the pane can name the device it waits on */
  attachPhase: Schema.optional(Schema.NullOr(DeviceAttachPhase)),
  /** booted devices plus anything Synara is booting */
  devices: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(64)),
  /** true while an agent tool is driving input */
  agentActive: Schema.Boolean,
  availability: DeviceAvailability,
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(DEVICE_MESSAGE_MAX_LENGTH))),
});
export type ThreadDeviceState = typeof ThreadDeviceState.Type;

/** Synara-booted devices are capped globally; viewing already-booted ones is not */
export const DEVICE_SYNARA_BOOT_LIMIT = 3;

const DeviceTargetInput = Schema.Struct({ udid: DeviceUdid });

export const DeviceListInput = Schema.Struct({
  /** the picker wants them, the agent usually doesn't */
  includeShutdown: Schema.optional(Schema.Boolean),
});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceListResult = Schema.Struct({
  devices: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(256)),
  availability: DeviceAvailability,
});
export type DeviceListResult = typeof DeviceListResult.Type;

export const DeviceBootInput = DeviceTargetInput;
export type DeviceBootInput = typeof DeviceBootInput.Type;

/** past DEVICE_SYNARA_BOOT_LIMIT the caller gets shutdown candidates so the pane can prompt instead of erroring */
export const DeviceBootResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("booted"), device: DeviceDescriptor }),
  Schema.Struct({
    kind: Schema.Literal("boot-limit-reached"),
    limit: NonNegativeInt,
    synaraBooted: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(64)),
  }),
]);
export type DeviceBootResult = typeof DeviceBootResult.Type;

export const DeviceShutdownInput = DeviceTargetInput;
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

export const DeviceAttachInput = Schema.Struct({
  threadId: ThreadId,
  udid: DeviceUdid,
});
export type DeviceAttachInput = typeof DeviceAttachInput.Type;

export const DeviceDetachInput = Schema.Struct({ threadId: ThreadId });
export type DeviceDetachInput = typeof DeviceDetachInput.Type;

export const DeviceThreadInput = Schema.Struct({ threadId: ThreadId });
export type DeviceThreadInput = typeof DeviceThreadInput.Type;

// device points, not pixels — clears any current iPad in points while rejecting mis-scaled canvas coordinates
const DeviceCoordinate = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }));

/** element targeting exists because coordinate arithmetic is where taps go wrong — a control merged into its row has a dead frame centre; the point form stays for unlabeled targets */
export const DeviceTapInput = Schema.Struct({
  udid: DeviceUdid,
  x: Schema.optional(DeviceCoordinate),
  y: Schema.optional(DeviceCoordinate),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type DeviceTapInput = typeof DeviceTapInput.Type;

export const DEVICE_SWIPE_DURATION_MIN_MS = 0;
export const DEVICE_SWIPE_DURATION_MAX_MS = 10_000;

export const DeviceSwipeInput = Schema.Struct({
  udid: DeviceUdid,
  fromX: DeviceCoordinate,
  fromY: DeviceCoordinate,
  toX: DeviceCoordinate,
  toY: DeviceCoordinate,
  durationMs: Schema.Int.check(
    Schema.isBetween({
      minimum: DEVICE_SWIPE_DURATION_MIN_MS,
      maximum: DEVICE_SWIPE_DURATION_MAX_MS,
    }),
  ),
});
export type DeviceSwipeInput = typeof DeviceSwipeInput.Type;

/** the helper synthesizes the key sequence so the agent sends one call */
export const DeviceTypeTextInput = Schema.Struct({
  udid: DeviceUdid,
  text: Schema.String.check(Schema.isMaxLength(DEVICE_TEXT_MAX_LENGTH)),
});
export type DeviceTypeTextInput = typeof DeviceTypeTextInput.Type;

export const DeviceKeyModifier = Schema.Literals([
  "command",
  "shift",
  "option",
  "control",
  "function",
]);
export type DeviceKeyModifier = typeof DeviceKeyModifier.Type;

/** down/up stay separate so held keys and repeats survive the hop */
export const DeviceKeyEventInput = Schema.Struct({
  udid: DeviceUdid,
  keyCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  modifiers: Schema.Array(DeviceKeyModifier).check(Schema.isMaxLength(5)),
  direction: Schema.Literals(["down", "up"]),
});
export type DeviceKeyEventInput = typeof DeviceKeyEventInput.Type;

export const DeviceHardwareButton = Schema.Literals([
  "home",
  "lock",
  "volume-up",
  "volume-down",
  "rotate",
]);
export type DeviceHardwareButton = typeof DeviceHardwareButton.Type;

export const DevicePressButtonInput = Schema.Struct({
  udid: DeviceUdid,
  button: DeviceHardwareButton,
});
export type DevicePressButtonInput = typeof DevicePressButtonInput.Type;

export const DeviceBundleId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceBundleId = typeof DeviceBundleId.Type;

export const DeviceInstallAppInput = Schema.Struct({
  udid: DeviceUdid,
  /** Synara never runs the build itself */
  appPath: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
});
export type DeviceInstallAppInput = typeof DeviceInstallAppInput.Type;

export const DeviceInstallAppResult = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
});
export type DeviceInstallAppResult = typeof DeviceInstallAppResult.Type;

export const DeviceLaunchAppInput = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
  arguments: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(1_024))).check(Schema.isMaxLength(64)),
  ),
});
export type DeviceLaunchAppInput = typeof DeviceLaunchAppInput.Type;

export const DeviceLaunchAppResult = Schema.Struct({
  udid: DeviceUdid,
  bundleId: DeviceBundleId,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type DeviceLaunchAppResult = typeof DeviceLaunchAppResult.Type;

export const DeviceOpenUrlInput = Schema.Struct({
  udid: DeviceUdid,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_URL_MAX_LENGTH)),
});
export type DeviceOpenUrlInput = typeof DeviceOpenUrlInput.Type;

export const DeviceScreenshotInput = Schema.Struct({
  udid: DeviceUdid,
  /** the pane sets this — recordings land in the same place (a browser download could land anywhere or nowhere); agents leave it unset */
  save: Schema.optional(Schema.Boolean),
});
export type DeviceScreenshotInput = typeof DeviceScreenshotInput.Type;

const DevicePixelDimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_384 }));

/** bytes travel base64 over the JSON WebSocket; the Uint8Array shape stays on Electron-only IPC */
export const DeviceScreenshotResult = Schema.Struct({
  udid: DeviceUdid,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  mimeType: Schema.Literal("image/png"),
  width: DevicePixelDimension,
  height: DevicePixelDimension,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 * 1024 * 1024 })),
  bytesBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(44 * 1024 * 1024)),
  capturedAt: IsoDateTime,
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH))),
});
export type DeviceScreenshotResult = typeof DeviceScreenshotResult.Type;

export const DeviceStartRecordingInput = DeviceTargetInput;
export type DeviceStartRecordingInput = typeof DeviceStartRecordingInput.Type;

export const DeviceStartRecordingResult = Schema.Struct({
  udid: DeviceUdid,
  /** absolute so the pane can reveal the file without reconstructing server paths */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
  /** server time keeps the recording UI independent of request latency and client clocks */
  startedAt: IsoDateTime,
});
export type DeviceStartRecordingResult = typeof DeviceStartRecordingResult.Type;

export const DeviceStopRecordingInput = DeviceTargetInput;
export type DeviceStopRecordingInput = typeof DeviceStopRecordingInput.Type;

export const DeviceStopRecordingResult = Schema.Struct({
  udid: DeviceUdid,
  /** stopping can finish after the pane that started it is gone */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVICE_PATH_MAX_LENGTH)),
  /** zero stays representable when simctl was killed before its first frame */
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** measured on the server so RPC transit isn't counted as footage */
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** lets callers order recordings completed after reconnects */
  stoppedAt: IsoDateTime,
});
export type DeviceStopRecordingResult = typeof DeviceStopRecordingResult.Type;

export const DeviceDescribeUiInput = DeviceTargetInput;
export type DeviceDescribeUiInput = typeof DeviceDescribeUiInput.Type;

export const DeviceUiFrame = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DeviceUiFrame = typeof DeviceUiFrame.Type;

export const DeviceUiPoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type DeviceUiPoint = typeof DeviceUiPoint.Type;

export interface DeviceUiNode {
  readonly role: string;
  /** separates controls sharing a role, e.g. Switch inside CheckBox */
  readonly subrole: string | null;
  readonly label: string | null;
  readonly value: string | null;
  readonly frame: DeviceUiFrame;
  /** UIKit merges a row + control into one element whose frame centre is dead space — tap this point instead whenever present */
  readonly activationPoint: DeviceUiPoint | null;
  readonly children: readonly DeviceUiNode[];
}

export const DeviceUiNode: Schema.Schema<DeviceUiNode> = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(128)),
  subrole: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  frame: DeviceUiFrame,
  activationPoint: Schema.NullOr(DeviceUiPoint),
  children: Schema.Array(Schema.suspend((): Schema.Schema<DeviceUiNode> => DeviceUiNode)).check(
    Schema.isMaxLength(512),
  ),
});

export const DeviceDescribeUiResult = Schema.Struct({
  udid: DeviceUdid,
  capturedAt: IsoDateTime,
  root: DeviceUiNode,
});
export type DeviceDescribeUiResult = typeof DeviceDescribeUiResult.Type;

/** the swipe loop belongs to the server — driven by hand it becomes distance guesses, overshoot, and a describe between attempts */
export const DEVICE_SCROLL_MIN_SWIPES = 1;
export const DEVICE_SCROLL_MAX_SWIPES = 32;

export const DeviceScrollToElementInput = Schema.Struct({
  udid: DeviceUdid,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  maxSwipes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: DEVICE_SCROLL_MIN_SWIPES, maximum: DEVICE_SCROLL_MAX_SWIPES }),
    ),
  ),
});
export type DeviceScrollToElementInput = typeof DeviceScrollToElementInput.Type;

export const DeviceScrollToElementResult = Schema.Struct({
  udid: DeviceUdid,
  /** the element as it stands after scrolling, ready to tap */
  element: DeviceUiNode,
  tapPoint: DeviceUiPoint,
});
export type DeviceScrollToElementResult = typeof DeviceScrollToElementResult.Type;

/** why the pane is being opened unprompted, so the UI can explain itself */
export const DeviceOpenPaneReason = Schema.Literals([
  "agent-install",
  "agent-launch",
  "agent-tool",
]);
export type DeviceOpenPaneReason = typeof DeviceOpenPaneReason.Type;

export const DeviceThreadStateEvent = Schema.Struct({
  type: Schema.Literal("device.thread-state"),
  state: ThreadDeviceState,
});
export type DeviceThreadStateEvent = typeof DeviceThreadStateEvent.Type;

/** carries the thread so whichever chat is visible can't steal the pane */
export const DeviceOpenPaneRequestedEvent = Schema.Struct({
  type: Schema.Literal("device.open-pane-requested"),
  threadId: ThreadId,
  udid: DeviceUdid,
  reason: DeviceOpenPaneReason,
});
export type DeviceOpenPaneRequestedEvent = typeof DeviceOpenPaneRequestedEvent.Type;

export const DeviceEvent = Schema.Union([DeviceThreadStateEvent, DeviceOpenPaneRequestedEvent]);
export type DeviceEvent = typeof DeviceEvent.Type;

/** frames ride the WebSocket as binary messages prefixed with this header so a frame routes without parsing the bitstream; codec lives in @synara/shared/deviceFrame; little-endian: u16 magic, u8 version, u8 flags(keyframe|codec-config), u32 seq, f64 timestampMs, deviceId, payload */
export const DEVICE_FRAME_MAGIC = 0x5346;
export const DEVICE_FRAME_VERSION = 1;
export const DEVICE_FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const DEVICE_FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;
/** bytes before the variable-length device id */
export const DEVICE_FRAME_HEADER_FIXED_BYTES = 17;
export const DEVICE_FRAME_MAX_DEVICE_ID_BYTES = 255;

export const DeviceFrameHeader = Schema.Struct({
  deviceId: DeviceUdid,
  sequence: NonNegativeInt,
  timestampMs: Schema.Finite,
  keyframe: Schema.Boolean,
  codecConfig: Schema.Boolean,
});
export type DeviceFrameHeader = typeof DeviceFrameHeader.Type;

export const DeviceFrameDecodeErrorReason = Schema.Literals([
  "too-short",
  "bad-magic",
  "unsupported-version",
  "truncated-device-id",
  "invalid-device-id",
]);
export type DeviceFrameDecodeErrorReason = typeof DeviceFrameDecodeErrorReason.Type;
