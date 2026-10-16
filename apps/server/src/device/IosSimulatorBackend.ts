/**
 * IosSimulatorBackend - the one DeviceBackend implementation today.
 *
 * Split by capability:
 *
 * - Discovery, boot/shutdown, install/launch/openurl, screenshots, and screen
 *   recordings go through `xcrun simctl`, which is public, stable, and needs
 *   no permissions.
 * - Input injection, the accessibility tree, and the video stream need private
 *   CoreSimulator/SimulatorKit APIs, so they go through the native helper
 *   (see `helperClient.ts`), compiled on demand against the user's Xcode.
 *
 * Availability is modelled rather than inferred from errors: the pane renders a
 * checklist (`DeviceAvailability`) instead of a stack trace, so every probe
 * here maps onto exactly one setup step.
 *
 * @module device/IosSimulatorBackend
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import type {
  DeviceAvailability,
  DeviceCapabilityId,
  DeviceDescribeUiResult,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHardwareButton,
  DeviceInstallAppResult,
  DeviceKeyModifier,
  DeviceLaunchAppResult,
  DeviceScreenshotResult,
  DeviceSetupStep,
  DeviceStartRecordingResult,
  DeviceStopRecordingResult,
  DeviceUiNode,
  DeviceUiPoint,
} from "@synara/contracts";

import {
  DEVICE_HELPER_BINARY_NAME,
  DEVICE_HELPER_CACHE_SEGMENTS,
  DEVICE_HELPER_SOURCE_DIR_ENV,
  deviceHelperCacheKey,
  readDeviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import {
  DeviceBackendError,
  fitDeviceMessage,
  type DeviceBackend,
  type DeviceConfiguration,
  type DeviceFrameListener,
  type DeviceKeyEvent,
  type DeviceLaunchOptions,
  type DeviceListOptions,
  type DeviceLogQuery,
  type DeviceLogResult,
  type DeviceScreenshotCapture,
  type DeviceSwipeGesture,
  type DeviceTypeTextOutcome,
} from "./DeviceBackend.ts";
import { readCrashReports, unifiedLogArguments, tailLines } from "./deviceLogs.ts";
import { readDeviceTypeCatalogue, type DeviceTypeCatalogue } from "./deviceTypeCatalogue.ts";
import {
  availabilityFromProbe,
  capabilityUnavailableMessage,
  parseHelperProbe,
  type HelperProbeResult,
} from "./helperCapabilities.ts";
import { HELPER_METHODS, HelperClient, type DeviceHelperError } from "./helperClient.ts";
import {
  SANDBOX_OPT_OUT_ENV,
  sandboxedHelperCommand,
  type HelperSandboxCommand,
} from "./helperSandbox.ts";

const SIMCTL_TIMEOUT_MS = 30_000;
/** How long one `simctl list devices` answer serves repeat callers; see listDevicesUnchecked. */
const DEVICE_LIST_CACHE_MS = 1_500;
/** How long the machine-wide `xcode-select -p` answer is reused; see xcodeSelectPath. */
const XCODE_SELECT_CACHE_MS = 15_000;
const BOOT_TIMEOUT_MS = 120_000;
const RECORDING_START_TIMEOUT_MS = 10_000;
const RECORDING_STOP_GRACE_MS = 15_000;
const RECORDING_KILL_GRACE_MS = 1_000;
const MAX_RECORDING_STDERR_LENGTH = 64 * 1024;
/** Screenshots are PNG on stdout-adjacent temp files; cap what we will read. */
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
/**
 * Characters per `text` RPC. The helper paces keystrokes at roughly 36 ms each
 * and every RPC shares a 15 s deadline, so a long string sent whole timed out
 * and the retry typed it a second time.
 */
const TEXT_CHUNK_LENGTH = 120;
/** The default CoreSimulator device set, whose `<udid>/data` is each guest's root. */
const SIMULATOR_DEVICES_ROOT = path.join(
  homedir(),
  "Library",
  "Developer",
  "CoreSimulator",
  "Devices",
);

export const DEVICE_HELPER_CACHE_ROOT = path.join(homedir(), ...DEVICE_HELPER_CACHE_SEGMENTS);

/**
 * Resolve the helper sources in both execution layouts.
 *
 * Source modules live under `src/device`, while tsdown collapses the server into
 * `dist/index.*` and the build copies the helper beside that bundle. Checking
 * the bundled layout first makes packaged desktop and published CLI builds use
 * their staged asset without changing the development path.
 */
export function resolveDeviceHelperSourceDir(
  moduleDirectory: string,
  sourceExists: (candidate: string) => boolean = (candidate) =>
    existsSync(path.join(candidate, "build.sh")),
  configuredDirectory: string | undefined = process.env[DEVICE_HELPER_SOURCE_DIR_ENV],
): string {
  if (configuredDirectory) {
    const external = path.resolve(configuredDirectory);
    if (sourceExists(external)) return external;
  }
  const bundled = path.resolve(moduleDirectory, "device-helper");
  if (sourceExists(bundled)) return bundled;
  return path.resolve(moduleDirectory, "..", "..", "native", "device-helper");
}

export type SpawnRecordingProcess = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface IosSimulatorBackendOptions {
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Absolute path to `apps/server/native/device-helper`. */
  readonly helperSourceDir?: string;
  readonly helperCacheRoot?: string;
  readonly run?: typeof runProcess;
  readonly makeHelperClient?: (
    binaryPath: string,
    env?: NodeJS.ProcessEnv,
    launch?: HelperSandboxCommand,
    onExit?: (reason: string) => void,
  ) => HelperClient;
  /** Keeps the long-lived simctl process controllable in tests. */
  readonly spawnProcess?: SpawnRecordingProcess;
  /** Tests isolate output without changing the user's normal save location. */
  readonly recordingDirectory?: string;
  readonly now?: () => number;
  /** Overridden in tests to exercise DEVELOPER_DIR without mutating process.env. */
  readonly processEnv?: NodeJS.ProcessEnv;
  /** Overridden in tests to simulate `/Applications` without touching the disk. */
  readonly listApplications?: () => Promise<readonly string[]>;
  /** Overridden alongside listApplications to control which bundles look real. */
  readonly xcodeBundleUsable?: (developerDir: string) => Promise<boolean>;
}

interface ActiveRecording {
  readonly child: ChildProcessWithoutNullStreams;
  readonly path: string;
  startedAt: string;
  stderr: string;
}

interface SimctlDevice {
  readonly udid?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly isAvailable?: unknown;
  readonly deviceTypeIdentifier?: unknown;
}

function mapSimctlState(raw: unknown): DeviceDescriptor["state"] {
  switch (String(raw)) {
    case "Booted":
      return "booted";
    case "Booting":
      return "booting";
    case "Shutting Down":
      return "shutting-down";
    default:
      return "shutdown";
  }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-0` -> `iOS 26.0`. */
function formatRuntimeIdentifier(identifier: string): string {
  const tail = identifier.split(".").pop() ?? identifier;
  const match = /^([A-Za-z]+)-(.+)$/u.exec(tail);
  if (!match) return tail;
  return `${match[1]} ${match[2]!.replace(/-/gu, ".")}`;
}

/**
 * Parse `simctl list devices --json`. Unavailable devices (runtime deleted,
 * profile missing) are dropped: showing them in the picker only produces boots
 * that fail.
 */
export function parseSimctlDevices(
  json: string,
  catalogue: DeviceTypeCatalogue = new Map(),
): readonly DeviceDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DeviceBackendError("Could not parse simctl device list");
  }
  const devicesByRuntime = (parsed as { devices?: unknown }).devices;
  if (typeof devicesByRuntime !== "object" || devicesByRuntime === null) return [];

  const devices: DeviceDescriptor[] = [];
  for (const [runtimeIdentifier, rawList] of Object.entries(
    devicesByRuntime as Record<string, unknown>,
  )) {
    if (!Array.isArray(rawList)) continue;
    const runtime = formatRuntimeIdentifier(runtimeIdentifier);
    for (const raw of rawList as readonly SimctlDevice[]) {
      if (raw.isAvailable === false) continue;
      const udid = typeof raw.udid === "string" ? raw.udid : null;
      const name = typeof raw.name === "string" ? raw.name : null;
      if (!udid || !name) continue;
      const deviceType =
        typeof raw.deviceTypeIdentifier === "string"
          ? catalogue.get(raw.deviceTypeIdentifier)
          : undefined;
      devices.push({
        platform: "ios-simulator",
        udid,
        name,
        runtime,
        state: mapSimctlState(raw.state),
        // Discovery cannot attribute a boot; DeviceManager overrides the ones
        // it booted itself.
        bootSource: "user",
        // Known from the device type profile, so the pane can draw the right
        // chassis the moment a device is picked rather than after it streams.
        ...(deviceType ? { family: deviceType.family, geometry: deviceType.geometry } : {}),
      });
    }
  }
  return devices;
}

export function hasBootableIosRuntime(devices: readonly DeviceDescriptor[]): boolean {
  return devices.length > 0;
}

/**
 * Order `/Applications` entries into Xcode bundle candidates, stable first.
 *
 * Stable `Xcode.app` wins when present because it is the predictable default;
 * a beta or versioned install (`Xcode-beta.app`, `Xcode-27.0.app`) is only
 * picked when it is the sole full Xcode on the machine. Exported for tests.
 */
export function orderXcodeAppCandidates(entries: readonly string[]): readonly string[] {
  return entries
    .filter((name) => name.startsWith("Xcode") && name.endsWith(".app"))
    .toSorted((a, b) => {
      if (a === "Xcode.app") return -1;
      if (b === "Xcode.app") return 1;
      return a.localeCompare(b);
    });
}

export async function selectRecordingDirectory(
  candidates: readonly string[],
  fallback: string,
): Promise<string> {
  for (const directory of candidates) {
    const usable = await stat(directory).then(
      async (info) => {
        if (!info.isDirectory()) return false;
        return await access(directory, fsConstants.W_OK).then(
          () => true,
          () => false,
        );
      },
      () => false,
    );
    if (usable) return directory;
  }
  return fallback;
}

export class IosSimulatorBackend implements DeviceBackend {
  readonly platform = "ios-simulator" as const;

  private readonly osPlatform: NodeJS.Platform;
  private readonly helperSourceDir: string;
  private readonly helperCacheRoot: string;
  private readonly run: typeof runProcess;
  private readonly makeHelperClient: (
    binaryPath: string,
    env?: NodeJS.ProcessEnv,
    launch?: HelperSandboxCommand,
    onExit?: (reason: string) => void,
  ) => HelperClient;
  /** The device the helper is streaming, so a helper death can name it. */
  private streamingUdid: string | null = null;
  private readonly streamInterruptedListeners = new Set<(udid: string, reason: string) => void>();
  /** One warning per backend when the helper runs unconfined. */
  private warnedUnsandboxed = false;
  private readonly spawnProcess: SpawnRecordingProcess;
  private readonly recordingDirectoryOverride: string | undefined;
  private readonly now: () => number;
  /** Injected so a test can set DEVELOPER_DIR without touching the real process. */
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly listApplications: () => Promise<readonly string[]>;
  private readonly xcodeBundleUsable: (developerDir: string) => Promise<boolean>;

  /** Geometry learned from helper attachments, keyed by udid. */
  private readonly deviceGeometry = new Map<string, DeviceGeometry>();
  /**
   * Screen geometry and product family per device type, read from the installed
   * simulator profiles. Cached for the process lifetime and shared by concurrent
   * callers: it only changes when a runtime is installed, and rebuilding it on
   * every listing would spawn a hundred processes per picker open.
   */
  private deviceTypes: Promise<DeviceTypeCatalogue> | null = null;
  /** One `/Applications` scan per process; see discoverXcodeDeveloperDir. */
  private xcodeDiscovery: Promise<string | null> | null = null;
  private xcodeSelectCache: {
    readonly resolvedAtMs: number;
    readonly developerDir: Promise<string | null>;
  } | null = null;
  private deviceListCache: {
    readonly listedAtMs: number;
    readonly devices: Promise<readonly DeviceDescriptor[]>;
  } | null = null;
  private helper: HelperClient | null = null;
  private helperBuildFailure: string | null = null;
  private helperCompilation: Promise<string> | null = null;
  /** The helper being started right now, shared by every caller that needs it. */
  private helperStart: Promise<HelperClient> | null = null;
  /** Keyed on the binary so a rebuilt helper is re-probed rather than assumed. */
  private helperProbe: { binaryPath: string; result: HelperProbeResult } | null = null;
  private readonly recordings = new Map<string, ActiveRecording>();
  /** Per-device answer to `usesUsKeyboardLayout`; dropped on boot and shutdown. */
  private readonly keyboardLayouts = new Map<string, Promise<boolean>>();
  /** `CFBundleExecutable` per udid+bundle, for log predicates and crash reports. */
  private readonly executables = new Map<string, Promise<string | null>>();
  private readonly recordingStarts = new Map<string, Promise<DeviceStartRecordingResult>>();
  private readonly recordingStops = new Map<string, Promise<DeviceStopRecordingResult>>();
  private readonly reservedRecordingPaths = new Set<string>();
  private disposed = false;

  constructor(options: IosSimulatorBackendOptions = {}) {
    this.osPlatform = options.platform ?? process.platform;
    this.processEnv = options.processEnv ?? process.env;
    this.helperSourceDir =
      options.helperSourceDir ??
      resolveDeviceHelperSourceDir(
        import.meta.dirname,
        undefined,
        this.processEnv[DEVICE_HELPER_SOURCE_DIR_ENV],
      );
    this.helperCacheRoot = options.helperCacheRoot ?? DEVICE_HELPER_CACHE_ROOT;
    this.run = options.run ?? runProcess;
    this.makeHelperClient =
      options.makeHelperClient ??
      ((binaryPath, env, launch, onExit) =>
        new HelperClient({ binaryPath, env, launch, ...(onExit ? { onExit } : {}) }));
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args) => spawn(command, [...args], { stdio: "pipe", windowsHide: true }));
    this.recordingDirectoryOverride = options.recordingDirectory;
    this.now = options.now ?? Date.now;
    this.listApplications = options.listApplications ?? (() => readdir("/Applications"));
    this.xcodeBundleUsable =
      options.xcodeBundleUsable ??
      ((developerDir) =>
        // `xcrun` is what every downstream command needs; its presence is what
        // separates a full Xcode from a leftover or half-deleted bundle.
        access(path.join(developerDir, "usr", "bin", "xcrun")).then(
          () => true,
          () => false,
        ));
  }

  // ── Availability ───────────────────────────────────────────────────

  async availability(): Promise<DeviceAvailability> {
    if (this.osPlatform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.osPlatform };
    }
    if (this.helperBuildFailure !== null) {
      return { kind: "helper-unavailable", message: this.helperBuildFailure };
    }

    const steps: DeviceSetupStep[] = [];
    const developerDir = await this.xcodeSelectPath();
    const xcodeInstalled = developerDir !== null && !developerDir.includes("CommandLineTools");
    steps.push({
      id: "install-xcode",
      label: "Install Xcode",
      done: xcodeInstalled,
      detail: xcodeInstalled ? undefined : "Install Xcode from the App Store, then open it once.",
    });
    steps.push({
      id: "select-xcode-command-line-tools",
      label: "Point the command line tools at Xcode",
      done: xcodeInstalled,
      detail: xcodeInstalled
        ? undefined
        : "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
    });

    const licenseAccepted = xcodeInstalled ? await this.xcodeLicenseAccepted() : false;
    steps.push({
      id: "accept-xcode-license",
      label: "Accept the Xcode license",
      done: licenseAccepted,
      detail: licenseAccepted ? undefined : "sudo xcodebuild -license accept",
    });

    const devices = licenseAccepted ? await this.listDevicesUnchecked() : [];
    const runtimeInstalled = hasBootableIosRuntime(devices);
    steps.push({
      id: "install-ios-runtime",
      label: "Install an iOS simulator runtime",
      done: runtimeInstalled,
      detail: runtimeInstalled ? undefined : "xcodebuild -downloadPlatform iOS",
    });

    // The helper is only built at first attach, so this step reports the cache
    // rather than forcing a compile during a routine availability probe.
    const helperBuilt = runtimeInstalled ? await this.cachedHelperPath().then(Boolean) : false;
    steps.push({
      id: "build-device-helper",
      label: "Build the Synara device helper",
      done: helperBuilt,
      detail: helperBuilt ? undefined : "Built automatically the first time you attach a device.",
    });

    if (!steps.every((step) => step.done)) {
      return { kind: "setup-required", steps };
    }

    // Setup is complete, so the remaining question is whether the private
    // symbols the helper needs still exist on this Xcode. A failure there is
    // degraded, not setup-required: nothing is left for the user to install.
    const probe = await this.probeHelperCapabilities();
    return probe === null ? { kind: "available" } : availabilityFromProbe(probe);
  }

  /**
   * Run the built helper's per-capability preflight.
   *
   * Cached for the process lifetime, keyed on the helper binary path: the
   * answer only changes when the toolchain does, and a new toolchain produces a
   * different cache key and therefore a different path. Returns null when no
   * helper is built yet, since there is nothing to probe.
   */
  private async probeHelperCapabilities(): Promise<HelperProbeResult | null> {
    const binaryPath = await this.cachedHelperPath();
    if (binaryPath === null) return null;
    if (this.helperProbe?.binaryPath === binaryPath) return this.helperProbe.result;

    // Confined exactly like the real run: a preflight under looser privileges
    // would report capabilities the sandboxed helper cannot actually deliver.
    const env = await this.toolchainEnv();
    const launch = await this.sandboxFor([binaryPath, "--probe"], env);
    const result = await this.run(launch.command, [...launch.args], {
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      env,
    }).catch(() => null);

    // A helper that will not launch is reported through the same shape, so
    // callers have one path to handle rather than two.
    const probe: HelperProbeResult =
      result === null
        ? {
            ok: false,
            capabilities: [],
            toolchain: undefined,
            error: "The device helper could not be launched.",
          }
        : parseHelperProbe(result.stdout);

    this.helperProbe = { binaryPath, result: probe };
    return probe;
  }

  /**
   * Throw when `capability` is broken on this machine, naming it and the Xcode
   * it broke on. Operations backed by a working capability never call this, so
   * one missing symbol cannot take the rest of the pane down.
   */
  async assertCapability(capability: DeviceCapabilityId): Promise<void> {
    const probe = await this.probeHelperCapabilities();
    if (probe === null) return;
    const status = probe.capabilities.find((entry) => entry.id === capability);
    if (!status || status.ok) return;
    throw new DeviceBackendError(capabilityUnavailableMessage(status, probe.toolchain));
  }

  // ── Discovery and lifecycle ────────────────────────────────────────

  async listDevices(options: DeviceListOptions = {}): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.listDevicesUnchecked();
    return options.includeShutdown === true
      ? devices
      : devices.filter((device) => device.state !== "shutdown");
  }

  async boot(udid: string): Promise<DeviceDescriptor> {
    this.keyboardLayouts.delete(udid);
    const result = await this.simctl(["boot", udid], { timeoutMs: BOOT_TIMEOUT_MS });
    // Booting an already-booted device is success, not failure: the pane and an
    // agent can race on the same device and neither should see an error.
    if (result.code !== 0 && !/current state: Booted/iu.test(result.stderr)) {
      throw this.simctlError("boot", result);
    }
    await this.simctl(["bootstatus", udid], { timeoutMs: BOOT_TIMEOUT_MS });
    const devices = await this.listDevicesUnchecked();
    const device = devices.find((candidate) => candidate.udid === udid);
    if (!device) throw new DeviceBackendError(`Device ${udid} disappeared after boot`);
    return { ...device, state: "booted" };
  }

  async shutdown(udid: string): Promise<void> {
    await this.stopRecordingForLifecycle(udid);
    await this.detachStream(udid);
    // The helper outlives the simulator, and its attachment holds a display
    // descriptor bound to this boot. Dropping it here means the next attach
    // rebinds instead of reusing a descriptor whose framebuffer is gone.
    this.helper?.invalidateAttachment(udid);
    this.keyboardLayouts.delete(udid);
    const result = await this.simctl(["shutdown", udid]);
    if (result.code !== 0 && !/current state: Shutdown/iu.test(result.stderr)) {
      throw this.simctlError("shutdown", result);
    }
  }

  async install(udid: string, appPath: string): Promise<DeviceInstallAppResult> {
    const bundleId = await this.readBundleIdentifier(appPath);
    const result = await this.simctl(["install", udid, appPath]);
    if (result.code !== 0) throw this.simctlError("install", result);
    return { udid, bundleId };
  }

  async launch(
    udid: string,
    bundleId: string,
    launchArguments: readonly string[] = [],
    options: DeviceLaunchOptions = {},
  ): Promise<DeviceLaunchAppResult> {
    // Do not redirect stdout/stderr into unbounded files or pipes whose
    // reader teardown could signal a still-running user app.
    const environment = Object.fromEntries(
      Object.entries(options.environment ?? {}).map(([key, value]) => [
        `SIMCTL_CHILD_${key}`,
        value,
      ]),
    );
    const result = await this.simctl(
      [
        "launch",
        ...(options.terminateExisting === true ? ["--terminate-running-process"] : []),
        udid,
        bundleId,
        ...launchArguments,
      ],
      { env: environment },
    );
    if (result.code !== 0) throw this.simctlError("launch", result);
    // `simctl launch` prints `<bundleId>: <pid>`.
    const match = /:\s*(\d+)\s*$/u.exec(result.stdout.trim());
    return { udid, bundleId, pid: match ? Number.parseInt(match[1]!, 10) : null };
  }

  async openUrl(udid: string, url: string): Promise<void> {
    const result = await this.simctl(["openurl", udid, url]);
    if (result.code !== 0) throw this.simctlError("openurl", result);
  }

  async screenshot(
    udid: string,
    options: {
      readonly save?: boolean;
      readonly maxInlineBytes?: number;
      readonly resolution?: "pixels" | "points";
      readonly proof?: boolean;
    } = {},
  ): Promise<DeviceScreenshotCapture> {
    // Captured to a temp file either way, because `simctl io screenshot` only
    // writes to a path. When the caller wants it kept, it is moved next to the
    // recordings afterwards rather than captured somewhere different.
    const directory = await mkdtemp(path.join(tmpdir(), "synara-device-"));
    const file = path.join(directory, "screenshot.png");
    try {
      await this.captureScreenshot(udid, file);
      const info = await stat(file);
      if (info.size > MAX_SCREENSHOT_BYTES) {
        throw new DeviceBackendError("Screenshot exceeded the maximum supported size");
      }
      const fullBytes = await readFile(file);
      const savedPath =
        options.save === true ? await this.saveScreenshotFile(udid, fullBytes) : null;
      const points =
        options.resolution === "points" ? await this.scaleToPoints(udid, file, directory) : null;
      if (options.resolution === "points" && points === null) {
        throw new DeviceBackendError(
          "Could not produce a screenshot in device-point coordinates. Describe the UI for tap points instead.",
        );
      }
      const sized = points ?? fullBytes;
      if (
        options.resolution === "points" &&
        options.maxInlineBytes !== undefined &&
        sized.byteLength > options.maxInlineBytes
      ) {
        throw new DeviceBackendError(
          "Point-resolution screenshot exceeds the inline image limit; use device_describe_ui for coordinates.",
        );
      }
      // Inline consumers (agent tool results) ride JSON-RPC frames with byte
      // caps, so oversized shots are resampled rather than rejected.
      const bytes =
        options.maxInlineBytes === undefined || sized.byteLength <= options.maxInlineBytes
          ? sized
          : await this.resampleScreenshotPng(file, directory, options.maxInlineBytes);
      const dimensions = readPngDimensions(bytes);
      return {
        ...(savedPath ? { path: savedPath } : {}),
        udid,
        name: `simulator-${udid}.png`,
        mimeType: "image/png",
        width: dimensions?.width ?? 1,
        height: dimensions?.height ?? 1,
        sizeBytes: bytes.byteLength,
        bytesBase64: bytes.toString("base64"),
        ...(options.proof ? { proofBytesBase64: fullBytes.toString("base64") } : {}),
        capturedAt: new Date().toISOString(),
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Capture through the attached helper when it can, which reads the
   * framebuffer in-process (~40 ms), and through `simctl io` otherwise (~430 ms,
   * but public API that survives a broken framebuffer path).
   */
  private async captureScreenshot(udid: string, file: string): Promise<void> {
    if (this.helper?.running && this.helper.attachedDevice?.udid === udid) {
      const viaHelper = await this.helperRequest(HELPER_METHODS.screenshot, { path: file }).then(
        () => true,
        () => false,
      );
      if (viaHelper) return;
    }
    const result = await this.simctl(["io", udid, "screenshot", file]);
    if (result.code !== 0) throw this.simctlError("screenshot", result);
  }

  /**
   * Resample to the screen's size in points, so a coordinate read off the image
   * is the device point a tap takes. Also the cheapest image a model can read:
   * a third of the pixels per side on a 3x screen. Null when the point size is
   * unknown or `sips` fails, in which case the caller keeps the full image.
   */
  private async scaleToPoints(
    udid: string,
    sourceFile: string,
    directory: string,
  ): Promise<Buffer | null> {
    const geometry = this.deviceGeometry.get(udid) ?? (await this.catalogueGeometry(udid));
    if (!geometry) return null;
    const target = path.join(directory, "screenshot-points.png");
    const result = await this.run(
      "/usr/bin/sips",
      [
        "-z",
        String(Math.round(geometry.pointHeight)),
        String(Math.round(geometry.pointWidth)),
        sourceFile,
        "--out",
        target,
      ],
      { timeoutMs: 10_000, allowNonZeroExit: true },
    ).catch(() => null);
    if (result === null || result.code !== 0) return null;
    return await readFile(target).catch(() => null);
  }

  private async catalogueGeometry(udid: string): Promise<DeviceGeometry | null> {
    const devices = await this.listDevicesUnchecked().catch(() => []);
    return devices.find((device) => device.udid === udid)?.geometry ?? null;
  }

  /**
   * Downscale a captured PNG with `sips` until it fits `maxBytes`. Stepping the
   * longest edge down keeps screenshots legible for models while staying well
   * under inline transport caps; a still-oversized result fails loudly instead
   * of silently breaking the agent's session transport.
   */
  private async resampleScreenshotPng(
    sourceFile: string,
    directory: string,
    maxBytes: number,
  ): Promise<Buffer> {
    let smallest: Buffer | null = null;
    for (const maxDimension of [1170, 840, 600]) {
      const target = path.join(directory, `screenshot-${String(maxDimension)}.png`);
      const result = await runProcess("/usr/bin/sips", [
        "-Z",
        String(maxDimension),
        sourceFile,
        "--out",
        target,
      ]);
      if (result.code !== 0) continue;
      const bytes = await readFile(target);
      if (bytes.byteLength <= maxBytes) return bytes;
      if (!smallest || bytes.byteLength < smallest.byteLength) smallest = bytes;
    }
    if (!smallest || smallest.byteLength > maxBytes) {
      throw new DeviceBackendError("Screenshot exceeded the maximum supported size");
    }
    return smallest;
  }

  /**
   * Keep a screenshot where the user will find it: the same Desktop/Downloads
   * directory recordings go to, named the same way, so one button's output does
   * not land somewhere different from the other's.
   */
  private async saveScreenshotFile(udid: string, bytes: Buffer): Promise<string> {
    const devices = await this.listDevicesUnchecked();
    const deviceName = devices.find((device) => device.udid === udid)?.name ?? udid;
    const target = await this.nextCapturePath(
      deviceName,
      new Date(this.now()).toISOString(),
      "png",
    );
    try {
      await writeFile(target, bytes);
      return target;
    } finally {
      // The reservation only guards against two captures in the same
      // millisecond choosing one name; the file on disk owns it from here.
      this.reservedRecordingPaths.delete(target);
    }
  }

  async startRecording(udid: string): Promise<DeviceStartRecordingResult> {
    if (this.disposed) throw new DeviceBackendError("The iOS simulator backend is disposed");
    if (this.recordings.has(udid) || this.recordingStarts.has(udid)) {
      throw new DeviceBackendError(`Device ${udid} is already recording`);
    }

    const starting = this.startRecordingProcess(udid);
    this.recordingStarts.set(udid, starting);
    try {
      return await starting;
    } finally {
      if (this.recordingStarts.get(udid) === starting) this.recordingStarts.delete(udid);
    }
  }

  async stopRecording(udid: string): Promise<DeviceStopRecordingResult> {
    const stopping = this.recordingStops.get(udid);
    if (stopping) return await stopping;

    const starting = this.recordingStarts.get(udid);
    if (starting) await starting;
    const resumedStopping = this.recordingStops.get(udid);
    if (resumedStopping) return await resumedStopping;
    const recording = this.recordings.get(udid);
    if (!recording) throw new DeviceBackendError(`Device ${udid} is not recording`);

    const pending = this.finishRecording(udid, recording);
    this.recordingStops.set(udid, pending);
    try {
      return await pending;
    } finally {
      if (this.recordingStops.get(udid) === pending) this.recordingStops.delete(udid);
    }
  }

  // ── Helper-backed capabilities ─────────────────────────────────────
  //
  // Each operation asserts only the capability it actually needs, so a symbol
  // Apple moved in one area cannot disable the others. Screenshots and screen
  // recordings are absent from this list on purpose: both run on public
  // `simctl io`, so they survive even a completely broken framebuffer path.

  /**
   * Send one HID injection, rebinding the helper's input client if the first
   * attempt was accepted but never reached the guest.
   *
   * The helper's HID client is bound to one boot of one simulator. When it goes
   * stale (the app under test relaunched, the device was rebooted outside
   * Synara, SimulatorKit dropped the connection) the injection silently
   * vanishes. The helper now reports that instead of acking it, and a forced
   * re-attach rebuilds the client, so the retry lands on a live one.
   */
  private async injectInput(
    udid: string,
    method: string,
    buildParams: (helper: HelperClient) => Record<string, unknown>,
  ): Promise<unknown> {
    await this.assertCapability("hid");
    const helper = await this.attachedHelper(udid);
    try {
      return await this.helperRequest(method, buildParams(helper));
    } catch (error) {
      if (!isInputNotDeliveredError(error)) throw error;
      // A budget refusal does not mean the now-ready transport is stale.
      // Leave it connected and let the caller retry the gesture deliberately.
      if (/input deadline/iu.test(errorText(error))) throw error;
      // Replaying keystrokes after a partial delivery types them twice. Only a
      // refusal that sent nothing is safe to repeat for a non-replayable call.
      if (!/(?:^|: )nothing was sent:/iu.test(errorText(error))) {
        throw error;
      }
      // dtuhidd still coming up after a boot: the attachment is fine and keeps
      // warming in the background, while a re-attach would restart the wait.
      if (/still starting/iu.test(errorText(error))) {
        return await this.helperRequest(method, buildParams(helper));
      }
    }
    const rebound = await this.attachedHelper(udid, { force: true });
    return await this.helperRequest(method, buildParams(rebound));
  }

  async tap(
    udid: string,
    x: number,
    y: number,
    options: { readonly holdMs?: number } = {},
  ): Promise<void> {
    await this.injectInput(udid, HELPER_METHODS.tap, (helper) => ({
      ...helper.normalize(x, y),
      ...(options.holdMs === undefined ? {} : { holdMs: Math.round(options.holdMs) }),
    }));
  }

  async swipe(udid: string, gesture: DeviceSwipeGesture): Promise<void> {
    await this.injectInput(udid, HELPER_METHODS.swipe, (helper) => {
      const start = helper.normalize(gesture.fromX, gesture.fromY);
      const end = helper.normalize(gesture.toX, gesture.toY);
      return {
        startX: start.x,
        startY: start.y,
        endX: end.x,
        endY: end.y,
        durationMs: gesture.durationMs,
        ...(gesture.edge === undefined ? {} : { edge: gesture.edge }),
      };
    });
  }

  async typeText(
    udid: string,
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<DeviceTypeTextOutcome> {
    let skipped = 0;
    for (let start = 0; start < text.length; start += TEXT_CHUNK_LENGTH) {
      options.signal?.throwIfAborted();
      const chunk = text.slice(start, start + TEXT_CHUNK_LENGTH);
      const result = await this.injectInput(udid, HELPER_METHODS.text, () => ({ text: chunk }));
      const chunkSkipped = (result as { skipped?: unknown } | null)?.skipped;
      if (typeof chunkSkipped === "number") skipped += chunkSkipped;
    }
    return { skipped };
  }

  async setFocusedValue(udid: string, value: string): Promise<void> {
    await this.assertCapability("accessibility");
    await this.attachedHelper(udid);
    await this.helperRequest(HELPER_METHODS.setFocusedValue, { value });
  }

  /**
   * HID keystrokes go through the guest's hardware keyboard layout: on an
   * Italian simulator the key that is "-" on a US keyboard types "'". Only a
   * device whose first keyboard (or, with none set, whose locale) is US English
   * gets keystrokes; the rest get exact text through accessibility.
   */
  async usesUsKeyboardLayout(udid: string): Promise<boolean> {
    let cached = this.keyboardLayouts.get(udid);
    if (!cached) {
      cached = (async () => {
        const keyboards = await this.simctl([
          "spawn",
          udid,
          "defaults",
          "read",
          "-g",
          "AppleKeyboards",
        ]);
        const firstKeyboard = /"?([A-Za-z]{2}[_-][A-Za-z]{2}[^",\s)]*)/u.exec(
          keyboards.code === 0 ? keyboards.stdout : "",
        )?.[1];
        if (firstKeyboard !== undefined) return /^en[_-]US\b/iu.test(firstKeyboard);
        const locale = await this.simctl(["spawn", udid, "defaults", "read", "-g", "AppleLocale"]);
        return locale.code === 0 && /^en[_-]US\b/iu.test(locale.stdout.trim());
      })().catch(() => false);
      this.keyboardLayouts.set(udid, cached);
    }
    return await cached;
  }

  // ── Environment and diagnostics ────────────────────────────────────

  async configure(udid: string, configuration: DeviceConfiguration): Promise<void> {
    const args = ((): readonly string[] => {
      switch (configuration.kind) {
        case "appearance":
          return ["ui", udid, "appearance", configuration.appearance];
        case "content-size":
          return ["ui", udid, "content_size", configuration.category];
        case "location":
          return ["location", udid, "set", `${configuration.latitude},${configuration.longitude}`];
        case "location-clear":
          return ["location", udid, "clear"];
        case "privacy":
          return [
            "privacy",
            udid,
            configuration.action,
            configuration.service,
            ...(configuration.bundleId === undefined ? [] : [configuration.bundleId]),
          ];
      }
    })();
    const result = await this.simctl(args);
    if (result.code !== 0) throw this.simctlError(args[0] ?? "configure", result);
  }

  async readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult> {
    const executable = await this.executableFor(udid, query.bundleId);
    const sinceMs = this.now() - query.sinceSeconds * 1000;
    const [unified, consoleLines, crashes] = await Promise.all([
      executable === null
        ? Promise.resolve<readonly string[]>([])
        : this.simctl(["spawn", udid, "log", ...unifiedLogArguments(executable, query)], {
            timeoutMs: 60_000,
          }).then((result) => {
            if (result.code !== 0) throw this.simctlError("log show", result);
            // `log show` prints a column header before the first entry.
            return result.stdout.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2} /u.test(line));
          }),
      Promise.resolve<readonly string[]>([]),
      executable === null
        ? Promise.resolve([])
        : readCrashReports({
            directory: path.join(homedir(), "Library", "Logs", "DiagnosticReports"),
            executable,
            udid,
            sinceMs,
          }),
    ]);
    const contains = query.contains?.toLowerCase();
    const filter = (lines: readonly string[]) =>
      contains === undefined
        ? lines
        : lines.filter((line) => line.toLowerCase().includes(contains));
    const log = tailLines(filter(unified), query.limit);
    const console = tailLines(filter(consoleLines), query.limit);
    return {
      bundleId: query.bundleId,
      process: executable,
      log: log.lines,
      console: console.lines,
      consoleUnavailableReason:
        "Direct stdout/stderr capture is unavailable; use Logger, NSLog or os_log for simulator output.",
      crashes,
      omitted: log.omitted + console.omitted,
    };
  }

  private executableFor(udid: string, bundleId: string): Promise<string | null> {
    const key = `${udid}:${bundleId}`;
    let cached = this.executables.get(key);
    if (!cached) {
      cached = this.simctl(["appinfo", udid, bundleId]).then((result) => {
        const match = /CFBundleExecutable\s*=\s*"?([^";\n]+)"?;/u.exec(result.stdout);
        if (result.code !== 0 && isDeviceNotBootedDetail(result.stderr)) {
          throw this.simctlError("appinfo", result);
        }
        if (result.code !== 0 || !match) {
          throw new DeviceBackendError(
            `App ${bundleId} is not installed on this simulator, so it has no logs to read.`,
          );
        }
        return match[1]!.trim();
      });
      // A failure is not remembered: the app may be installed a moment later.
      cached.catch(() => this.executables.delete(key));
      this.executables.set(key, cached);
    }
    return cached;
  }

  async keyEvent(udid: string, event: DeviceKeyEvent): Promise<void> {
    // The helper takes one USB HID usage per call and tracks held modifiers
    // itself, so a chord is sent as its modifier keys around the main key.
    for (const modifier of event.modifiers) {
      const usage = HID_MODIFIER_USAGES[modifier];
      if (usage === undefined) continue;
      await this.injectInput(udid, HELPER_METHODS.key, () => ({
        usage,
        phase: event.direction,
      }));
    }
    await this.injectInput(udid, HELPER_METHODS.key, () => ({
      usage: event.keyCode,
      phase: event.direction,
    }));
  }

  async pressButton(udid: string, button: DeviceHardwareButton): Promise<void> {
    if (button === "rotate") {
      // Rotation is a Simulator.app window command, not a HID button: there is
      // no HID usage for it and no simctl equivalent. Simulator.app posts a
      // Purple event through a category it compiles into its own executable,
      // and that port is not wired on a headless boot — calling it there is a
      // silent no-op (docs/archive/device-pane-spec.md has the full probe). Refused
      // explicitly rather than pretending to work; the pane ships no rotate
      // control for the same reason, and this keeps the agent tool honest.
      throw new DeviceBackendError(
        "Rotating a headless simulator is not supported; rotate the device from inside the app or use Simulator.app.",
      );
    }
    await this.assertCapability("hid");
    await this.injectInput(udid, HELPER_METHODS.button, () => ({ name: button }));
  }

  async describeUi(udid: string): Promise<DeviceDescribeUiResult> {
    await this.assertCapability("accessibility");
    await this.attachedHelper(udid);
    const result = await this.helperRequest(HELPER_METHODS.describeUi, {});
    const tree = (result as { tree?: unknown } | null)?.tree;
    if (typeof tree !== "object" || tree === null) {
      throw new DeviceBackendError("Device helper returned no accessibility tree");
    }
    return {
      udid,
      capturedAt: new Date().toISOString(),
      root: normalizeUiNode(tree),
    };
  }

  geometry(udid: string): DeviceGeometry | null {
    return this.deviceGeometry.get(udid) ?? null;
  }

  async attachStream(udid: string, onFrame: DeviceFrameListener): Promise<void> {
    // Streaming needs both halves of the pipeline: the framebuffer to read and
    // the encoder to compress it.
    await this.assertCapability("framebuffer");
    await this.assertCapability("encoder");
    const helper = await this.attachedHelper(udid);
    try {
      await helper.startStream(udid, onFrame);
    } catch (error) {
      // After a reboot outside Synara the cached attachment still looks valid,
      // and starting the stream on it fails with "no framebuffer surface" on
      // every retry. A fresh attach against the current boot fixes it at once.
      if (!isStaleDescriptorError(error)) throw error;
      await this.attachedHelper(udid, { force: true });
      await helper.startStream(udid, onFrame);
    }
    this.streamingUdid = udid;
  }

  async detachStream(udid: string): Promise<void> {
    if (this.streamingUdid === udid) this.streamingUdid = null;
    // The helper holds one attachment, so its stream is this device's stream.
    if (!this.helper || this.helper.attachedDevice?.udid !== udid) return;
    await this.helper.stopStream().catch(() => undefined);
  }

  onStreamInterrupted(listener: (udid: string, reason: string) => void): () => void {
    this.streamInterruptedListeners.add(listener);
    return () => {
      this.streamInterruptedListeners.delete(listener);
    };
  }

  /**
   * The helper process exited. A running stream died with it, which nothing
   * else reports: frames just stop. The next request starts a new helper; the
   * listeners decide whether the stream is still wanted.
   */
  private helperExited(helper: HelperClient, reason: string): void {
    if (this.disposed || this.helper !== helper) return;
    const udid = this.streamingUdid;
    this.streamingUdid = null;
    if (udid === null) return;
    for (const listener of this.streamInterruptedListeners) {
      try {
        listener(udid, reason);
      } catch {
        // One listener's failure must not hide the interruption from the rest.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = Array.from(this.recordings.values());
    await Promise.all(active.map((recording) => this.interruptRecording(recording)));
    await Promise.allSettled(this.recordingStarts.values());
    this.recordings.clear();
    this.reservedRecordingPaths.clear();
    const helper = this.helper;
    this.helper = null;
    await helper?.dispose();
  }

  private async startRecordingProcess(udid: string): Promise<DeviceStartRecordingResult> {
    if (this.osPlatform !== "darwin") {
      throw new DeviceBackendError("iOS simulators are only available on macOS");
    }
    const devices = await this.listDevicesUnchecked();
    const deviceName = devices.find((device) => device.udid === udid)?.name ?? udid;
    const requestedAt = new Date(this.now()).toISOString();
    const outputPath = await this.nextCapturePath(deviceName, requestedAt, "mp4");
    if (this.disposed) {
      this.reservedRecordingPaths.delete(outputPath);
      throw new DeviceBackendError("The iOS simulator backend is disposed");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess("xcrun", [
        "simctl",
        "io",
        udid,
        "recordVideo",
        "--codec=h264",
        outputPath,
      ]);
    } catch (cause) {
      this.reservedRecordingPaths.delete(outputPath);
      throw new DeviceBackendError(`Could not start simulator recording: ${errorText(cause)}`, {
        cause,
      });
    }

    const recording: ActiveRecording = {
      child,
      path: outputPath,
      startedAt: requestedAt,
      stderr: "",
    };
    this.recordings.set(udid, recording);
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer | string) => {
      recording.stderr = `${recording.stderr}${chunk.toString()}`.slice(
        -MAX_RECORDING_STDERR_LENGTH,
      );
    });
    child.once("close", () => {
      if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
      this.reservedRecordingPaths.delete(outputPath);
    });

    try {
      await this.waitForRecordingStart(recording);
      if (processHasExited(child)) {
        throw new DeviceBackendError("simctl recordVideo exited as recording began");
      }
      recording.startedAt = new Date(this.now()).toISOString();
      return { udid, path: outputPath, startedAt: recording.startedAt };
    } catch (cause) {
      await this.interruptRecording(recording);
      if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
      this.reservedRecordingPaths.delete(outputPath);
      await rm(outputPath, { force: true }).catch(() => undefined);
      if (cause instanceof DeviceBackendError) throw cause;
      throw new DeviceBackendError(`Could not start simulator recording: ${errorText(cause)}`, {
        cause,
      });
    }
  }

  private async finishRecording(
    udid: string,
    recording: ActiveRecording,
  ): Promise<DeviceStopRecordingResult> {
    await this.interruptRecording(recording);
    if (this.recordings.get(udid) === recording) this.recordings.delete(udid);
    this.reservedRecordingPaths.delete(recording.path);

    const info = await stat(recording.path).catch((cause: unknown) => {
      throw new DeviceBackendError(
        `Simulator recording finished without a readable file at ${recording.path}`,
        { cause },
      );
    });
    const stoppedAtMs = this.now();
    return {
      udid,
      path: recording.path,
      sizeBytes: info.size,
      durationMs: Math.max(0, Math.floor(stoppedAtMs - Date.parse(recording.startedAt))),
      stoppedAt: new Date(stoppedAtMs).toISOString(),
    };
  }

  private waitForRecordingStart(recording: ActiveRecording): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: { readonly error?: DeviceBackendError }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        recording.child.stderr.off("data", onStderr);
        recording.child.off("error", onError);
        recording.child.off("close", onClose);
        if (result.error) reject(result.error);
        else resolve();
      };
      const onStderr = (): void => {
        if (/Recording started/iu.test(recording.stderr)) finish({});
      };
      const onError = (cause: Error): void => {
        finish({
          error: new DeviceBackendError(
            `Could not start simulator recording: ${errorText(cause)}`,
            { cause },
          ),
        });
      };
      const onClose = (): void => {
        const detail = recording.stderr.trim();
        finish({
          error: new DeviceBackendError(
            `simctl recordVideo exited before recording started${detail ? `: ${detail}` : ""}`,
          ),
        });
      };
      const timer = setTimeout(() => {
        finish({
          error: new DeviceBackendError(
            `simctl recordVideo did not start within ${RECORDING_START_TIMEOUT_MS}ms`,
            { retryable: true },
          ),
        });
      }, RECORDING_START_TIMEOUT_MS);
      timer.unref?.();
      recording.child.stderr.on("data", onStderr);
      recording.child.once("error", onError);
      recording.child.once("close", onClose);
      if (processHasExited(recording.child)) onClose();
    });
  }

  private async interruptRecording(recording: ActiveRecording): Promise<void> {
    if (processHasExited(recording.child)) return;
    const gracefulExit = waitForProcessExit(recording.child, RECORDING_STOP_GRACE_MS);
    recording.child.kill("SIGINT");
    if (await gracefulExit) return;

    const forcedExit = waitForProcessExit(recording.child, RECORDING_KILL_GRACE_MS);
    recording.child.kill("SIGKILL");
    await forcedExit;
  }

  private async stopRecordingForLifecycle(udid: string): Promise<void> {
    const starting = this.recordingStarts.get(udid);
    if (starting) await starting.catch(() => undefined);
    if (!this.recordings.has(udid)) return;
    await this.stopRecording(udid).catch(() => undefined);
  }

  /** Unique path for a capture, shared by recordings (mp4) and screenshots (png). */
  private async nextCapturePath(
    deviceName: string,
    startedAt: string,
    extension: "mp4" | "png",
  ): Promise<string> {
    const directory = await this.recordingDirectory();
    const slug = slugDeviceName(deviceName);
    const timestamp = startedAt.replace(/[:.]/gu, "-");
    const base = `simulator-${slug}-${timestamp}`;
    for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
      const candidate = path.join(
        directory,
        `${base}${suffix === 1 ? "" : `-${suffix}`}.${extension}`,
      );
      if (this.reservedRecordingPaths.has(candidate)) continue;
      const exists = await stat(candidate).then(
        () => true,
        (cause: unknown) => {
          if (isMissingPathError(cause)) return false;
          throw new DeviceBackendError(`Could not inspect capture path ${candidate}`, { cause });
        },
      );
      if (exists) continue;
      this.reservedRecordingPaths.add(candidate);
      return candidate;
    }
    throw new DeviceBackendError(`Could not choose a unique capture path in ${directory}`);
  }

  private async recordingDirectory(): Promise<string> {
    if (this.recordingDirectoryOverride) return path.resolve(this.recordingDirectoryOverride);
    return await selectRecordingDirectory(
      [path.join(homedir(), "Desktop"), path.join(homedir(), "Downloads")],
      tmpdir(),
    );
  }

  // ── simctl plumbing ────────────────────────────────────────────────

  private async simctl(
    args: readonly string[],
    options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
  ): Promise<ProcessRunResult> {
    if (this.osPlatform !== "darwin") {
      throw new DeviceBackendError("iOS simulators are only available on macOS");
    }
    // Anything but a read can change what `list devices` reports; drop the
    // short-lived listing cache before the command runs so the next listing
    // sees the mutation (boot, shutdown, create, erase, ...).
    if (!READ_ONLY_SIMCTL_COMMANDS.has(args[0] ?? "")) this.deviceListCache = null;
    const toolchain = await this.toolchainEnv();
    return await this.run("xcrun", ["simctl", ...args], {
      timeoutMs: options.timeoutMs ?? SIMCTL_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
      env:
        options.env === undefined
          ? toolchain
          : { ...(toolchain ?? this.processEnv), ...options.env },
    });
  }

  private simctlError(action: string, result: ProcessRunResult): DeviceBackendError {
    const detail = result.stderr.trim() || result.stdout.trim();
    // CoreSimulator answers a command for a shut-down device with SimError 405
    // "Unable to lookup in current state: Shutdown", which an agent reads as a
    // broken app or a missing install rather than the one step it skipped.
    if (isDeviceNotBootedDetail(detail)) {
      return new DeviceBackendError(
        `simctl ${action} failed because the simulator is not booted. Boot it with device_boot, then retry.`,
      );
    }
    return new DeviceBackendError(
      `simctl ${action} failed${detail ? `: ${detail}` : ""}`,
      // A timeout may still be progressing on the device; a refusal will not.
      { retryable: result.timedOut },
    );
  }

  /**
   * One `simctl list` serves every caller within a short window: a single
   * manager snapshot lists twice (availability, then discovery) and agent tool
   * calls arrive seconds apart. The window is short enough that a device the
   * user boots from Simulator.app still shows up promptly, and any simctl
   * mutation issued through this backend drops the cache immediately.
   */
  private async listDevicesUnchecked(): Promise<readonly DeviceDescriptor[]> {
    if (this.osPlatform !== "darwin") return [];
    const cached = this.deviceListCache;
    if (cached !== null && Date.now() - cached.listedAtMs < DEVICE_LIST_CACHE_MS) {
      return await cached.devices;
    }
    const listedAtMs = Date.now();
    const devices = this.listDevicesFresh();
    const entry = { listedAtMs, devices };
    this.deviceListCache = entry;
    try {
      return await devices;
    } catch (error) {
      if (this.deviceListCache === entry) this.deviceListCache = null;
      throw error;
    }
  }

  private async listDevicesFresh(): Promise<readonly DeviceDescriptor[]> {
    const [result, catalogue] = await Promise.all([
      this.simctl(["list", "devices", "--json"]).catch(() => null),
      this.deviceTypeCatalogue(),
    ]);
    if (!result || result.code !== 0) return [];
    try {
      return parseSimctlDevices(result.stdout, catalogue);
    } catch {
      return [];
    }
  }

  private async deviceTypeCatalogue(): Promise<DeviceTypeCatalogue> {
    if (this.osPlatform !== "darwin") return new Map();
    this.deviceTypes ??= readDeviceTypeCatalogue({
      run: this.run,
      env: await this.toolchainEnv(),
      // A failed read means no pre-boot geometry, not a broken pane, so it is
      // not remembered as a failure the way a helper build is.
    }).catch(() => new Map<string, never>());
    return await this.deviceTypes;
  }

  /**
   * The developer directory every simulator command runs against.
   *
   * `DEVELOPER_DIR` wins over the machine-wide selection, because that is how a
   * beta Xcode gets targeted: pointing one process at `Xcode-beta.app` is the
   * whole point, and `sudo xcode-select -s` would move every other build on the
   * machine onto the beta as well. Reading only `xcode-select -p` meant a user
   * who set the variable silently got the stable toolchain instead.
   */
  private developerDirOverride(): string | null {
    const override = this.processEnv.DEVELOPER_DIR?.trim();
    return override !== undefined && override.length > 0 ? override : null;
  }

  /**
   * Environment for `simctl`, `xcodebuild` and the helper build, pinning them
   * all to one toolchain. Without it a child process resolving `xcode-select -p`
   * for itself could pick a different Xcode than the one availability just
   * reported, which is how a beta run ends up half on each.
   */
  private async toolchainEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    const developerDir = await this.xcodeSelectPath();
    return developerDir === null ? undefined : { ...this.processEnv, DEVELOPER_DIR: developerDir };
  }

  private async xcodeSelectPath(): Promise<string | null> {
    const override = this.developerDirOverride();
    if (override !== null) return override;
    const cached = this.xcodeSelectCache;
    if (cached !== null && Date.now() - cached.resolvedAtMs < XCODE_SELECT_CACHE_MS) {
      return await cached.developerDir;
    }
    const entry = { resolvedAtMs: Date.now(), developerDir: this.resolveXcodeSelectPath() };
    this.xcodeSelectCache = entry;
    return await entry.developerDir;
  }

  /**
   * The machine-wide selection, re-read on a short interval rather than once
   * per process: `sudo xcode-select -s` from the setup checklist must take
   * effect without a restart, but `toolchainEnv()` consults this for every
   * simctl and xcodebuild spawn, which made it the most-run subprocess.
   */
  private async resolveXcodeSelectPath(): Promise<string | null> {
    const result = await this.run("xcode-select", ["-p"], {
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    const selected =
      result !== null && result.code === 0 && result.stdout.trim().length > 0
        ? result.stdout.trim()
        : null;
    if (selected !== null && !selected.includes("CommandLineTools")) return selected;
    // The machine-wide selection is CommandLineTools (the macOS default after
    // installing git) or absent, but a full Xcode may still be installed —
    // beta-only machines commonly have `Xcode-beta.app` and never ran
    // `xcode-select -s`. Discovering it here turns "run sudo xcode-select"
    // from a setup blocker into a fallback instruction.
    return (await this.discoverXcodeDeveloperDir()) ?? selected;
  }

  /**
   * Find a full Xcode under `/Applications` without `xcode-select`.
   *
   * Cached for the process lifetime: installs are rare, and this backs
   * `toolchainEnv()`, which runs for every simctl call.
   */
  private discoverXcodeDeveloperDir(): Promise<string | null> {
    this.xcodeDiscovery ??= (async () => {
      const entries = await this.listApplications().catch(() => [] as string[]);
      for (const name of orderXcodeAppCandidates(entries)) {
        const developerDir = path.join("/Applications", name, "Contents", "Developer");
        if (await this.xcodeBundleUsable(developerDir)) return developerDir;
      }
      return null;
    })();
    return this.xcodeDiscovery;
  }

  private async xcodeLicenseAccepted(): Promise<boolean> {
    const result = await this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
      env: await this.toolchainEnv(),
    }).catch(() => null);
    return result !== null && result.code === 0;
  }

  private async readBundleIdentifier(appPath: string): Promise<string> {
    const plist = path.join(appPath, "Info.plist");
    const result = await this.run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", plist],
      { timeoutMs: 10_000, allowNonZeroExit: true },
    ).catch(() => null);
    const bundleId = result?.code === 0 ? result.stdout.trim() : "";
    if (bundleId.length === 0) {
      throw new DeviceBackendError(`Could not read CFBundleIdentifier from ${plist}`);
    }
    return bundleId;
  }

  // ── Helper lifecycle ───────────────────────────────────────────────

  private async helperRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const helper = await this.requireHelper();
    try {
      return await helper.request(method, params);
    } catch (error) {
      throw this.helperError(error);
    }
  }

  private helperError(error: unknown): DeviceBackendError {
    const helperError = error as DeviceHelperError;
    return new DeviceBackendError(
      helperError?.message ?? "Device helper failed",
      // A timeout may still be progressing on the device; a refusal will not.
      { retryable: helperError?.code === "helper_timeout", cause: error },
    );
  }

  /**
   * The helper is bound to one simulator at a time and every input and read
   * method acts on that binding, so each call re-asserts it. `attach` is a
   * no-op when the device is already the attached one.
   */
  private async attachedHelper(
    udid: string,
    options: { readonly force?: boolean } = {},
  ): Promise<HelperClient> {
    const helper = await this.requireHelper();
    const remember = () => {
      const attachment = helper.attachedDevice;
      if (attachment?.udid === udid) {
        this.deviceGeometry.set(udid, {
          pointWidth: attachment.pointWidth,
          pointHeight: attachment.pointHeight,
          scale: attachment.scale,
        });
      }
    };
    try {
      await helper.attach(udid, options);
      remember();
    } catch (error) {
      // A device can also be rebooted outside Synara (Simulator.app, or simctl
      // in the agent's own shell), which no invalidation hook here can observe.
      // A dead-descriptor failure is therefore retried once with a forced
      // re-attach, which rebinds against the current boot.
      if (!isStaleDescriptorError(error)) throw this.helperError(error);
      try {
        await helper.attach(udid, { force: true });
        remember();
      } catch (retryError) {
        throw this.helperError(retryError);
      }
    }
    return helper;
  }

  private async requireHelper(): Promise<HelperClient> {
    if (this.helper?.running) return this.helper;
    // Starting a helper takes several awaits. Without sharing the start, two
    // callers arriving together (the pane's stream and an agent's tap) would
    // each spawn a helper, and the first one would never be disposed.
    this.helperStart ??= this.startHelper().finally(() => {
      this.helperStart = null;
    });
    return await this.helperStart;
  }

  private async startHelper(): Promise<HelperClient> {
    const retired = this.helper;
    this.helper = null;
    await retired?.dispose();
    const binaryPath = await this.compileHelperIfNeeded();
    // The helper resolves CoreSimulator out of DEVELOPER_DIR at runtime, so it
    // has to inherit the same toolchain the binary was built against.
    const env = await this.toolchainEnv();
    const sandbox = await this.sandboxFor([binaryPath], env);
    if (this.disposed) throw new DeviceBackendError("The iOS simulator backend is disposed");
    const helper: HelperClient = this.makeHelperClient(binaryPath, env, sandbox, (reason) =>
      this.helperExited(helper, reason),
    );
    helper.start();
    this.helper = helper;
    return helper;
  }

  /**
   * Build the helper against the current Xcode, or reuse the cached binary.
   *
   * Keyed by the Xcode build number because the helper links private
   * frameworks whose symbols move between releases: a cache hit from a previous
   * Xcode would crash at runtime rather than fail to compile. Concurrent
   * callers share one compilation.
   */
  async compileHelperIfNeeded(): Promise<string> {
    const cached = await this.cachedHelperPath();
    if (cached) return cached;
    this.helperCompilation ??= this.compileHelper().finally(() => {
      this.helperCompilation = null;
    });
    return await this.helperCompilation;
  }

  private async compileHelper(): Promise<string> {
    const buildScript = path.join(this.helperSourceDir, "build.sh");
    const key = await this.xcodeBuildKey().catch((error: unknown) => {
      throw this.recordHelperFailure(error instanceof Error ? error.message : String(error));
    });
    const outputDirectory = path.join(this.helperCacheRoot, key);
    const result = await this.run("/bin/sh", [buildScript, outputDirectory], {
      timeoutMs: 300_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
      // The helper links this toolchain's private frameworks, so it must build
      // against the same Xcode the rest of the session talks to.
      env: await this.toolchainEnv(),
    }).catch((error: unknown) => {
      throw this.recordHelperFailure(
        error instanceof Error ? error.message : "Device helper build could not start",
      );
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw this.recordHelperFailure(
        `Device helper build failed${detail ? `: ${detail}` : ""}. Verify Xcode is installed and its license accepted.`,
      );
    }
    const binaryPath = path.join(outputDirectory, DEVICE_HELPER_BINARY_NAME);
    const exists = await stat(binaryPath).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw this.recordHelperFailure("Device helper build produced no binary");
    }
    this.helperBuildFailure = null;
    return binaryPath;
  }

  private recordHelperFailure(message: string): DeviceBackendError {
    // Remembered so `availability()` reports `helper-unavailable` instead of
    // the pane retrying a build that will keep failing the same way.
    this.helperBuildFailure = fitDeviceMessage(message);
    return new DeviceBackendError(message);
  }

  private async cachedHelperPath(): Promise<string | null> {
    if (this.osPlatform !== "darwin") return null;
    const key = await this.xcodeBuildKey().catch(() => null);
    if (key === null) return null;
    const binaryPath = path.join(this.helperCacheRoot, key, DEVICE_HELPER_BINARY_NAME);
    return await stat(binaryPath).then(
      () => binaryPath,
      () => null,
    );
  }

  /**
   * The Seatbelt-wrapped command for a helper run, or the plain one.
   *
   * Shared by the long-lived RPC helper and the one-shot `--probe`: preflighting
   * unconfined while the real run is confined would let a broken profile pass
   * the setup checklist and then hang on attach. Logs once when confinement is
   * skipped, since a silently unconfined helper is the thing worth noticing.
   */
  private async sandboxFor(
    argv: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<HelperSandboxCommand> {
    const binaryPath = argv[0] ?? "";
    const launch = await sandboxedHelperCommand(argv, {
      binaryPath,
      helperSourceDir: this.helperSourceDir,
      developerDir: await this.xcodeSelectPath(),
      env: env ?? this.processEnv,
    });
    if (launch.profilePath === null && process.platform === "darwin" && !this.warnedUnsandboxed) {
      this.warnedUnsandboxed = true;
      console.warn(
        `[device] the iOS Simulator helper is running WITHOUT its Seatbelt sandbox. It can read` +
          ` your files and open network sockets. Unset ${SANDBOX_OPT_OUT_ENV} to restore` +
          ` confinement.`,
      );
    }
    return launch;
  }

  /**
   * Digest of the helper's sources, so a helper fix invalidates the cache.
   *
   * Read fresh rather than memoised: it runs once per attach, and a stale
   * digest would reintroduce exactly the bug it exists to prevent. If the
   * sources cannot be read the digest is omitted, which falls back to keying on
   * the toolchain alone rather than failing the attach outright.
   */
  /**
   * Digest of the helper's sources, so a helper fix invalidates the cache.
   *
   * Derived through the shared reader that `scripts/device-helper-smoke.ts`
   * also uses: a second derivation here is what made the smoke run build into a
   * directory this backend never read.
   */
  private async helperSourceRevision(): Promise<string | undefined> {
    return await readDeviceHelperSourceRevision(this.helperSourceDir, {
      listSources: readdir,
      readFile: (file) => readFile(file, "utf8"),
      join: path.join,
    });
  }

  private async xcodeBuildKey(): Promise<string> {
    const result = await this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      allowNonZeroExit: true,
      env: await this.toolchainEnv(),
    }).catch(() => null);
    // Derived by the shared helper so the smoke CLI writes the directory the
    // server reads; deriving it here independently is what let them diverge.
    const key =
      result?.code === 0
        ? deviceHelperCacheKey(result.stdout, await this.helperSourceRevision())
        : null;
    // Not recorded as a helper failure here: this also runs on every cache
    // lookup, and one slow or failed call (Xcode updating, a license prompt)
    // would otherwise leave the pane on "helper unavailable" until restart.
    // compileHelper records it when the failure actually blocks a build.
    if (key === null) {
      throw new DeviceBackendError(
        "Could not determine the Xcode version. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      );
    }
    return key;
  }
}

/** SimError 405: the command needs a booted device and this one is not. */
function isDeviceNotBootedDetail(detail: string): boolean {
  return /current state: (?:Shutdown|Shutting Down)|code=405/iu.test(detail);
}

/** simctl commands that cannot change what `list devices` reports. */
const READ_ONLY_SIMCTL_COMMANDS = new Set([
  "list",
  "appinfo",
  "spawn",
  "location",
  "ui",
  "privacy",
]);

function slugDeviceName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "device"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function processHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (processHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

/**
 * Does this failure mean the helper is holding a display descriptor from a
 * previous boot? The helper reports it as a missing framebuffer surface, since
 * from its side the descriptor is valid but has nothing behind it.
 */
/**
 * Did the helper accept an injection it could not deliver? Distinct from a
 * stale descriptor: the attachment is live enough to answer, but its HID client
 * is bound to a boot that is gone, so the fix is to rebind and retry once.
 */
function isInputNotDeliveredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not delivered to the simulator/iu.test(message);
}

export function isStaleDescriptorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /framebuffer surface|display has no|not attached/iu.test(message);
}

/** USB HID keyboard usage codes for the modifiers the contract exposes. */
const HID_MODIFIER_USAGES: Partial<Record<DeviceKeyModifier, number>> = {
  control: 0xe0,
  shift: 0xe1,
  option: 0xe2,
  command: 0xe3,
};

/**
 * The helper omits absent accessibility attributes rather than sending nulls,
 * and its frames are in display coordinates. Fill in the contract's shape so
 * the pane and the agent see one predictable node type.
 */
export function normalizeUiNode(raw: unknown): DeviceUiNode {
  const node = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const frame =
    typeof node.frame === "object" && node.frame !== null
      ? (node.frame as Record<string, unknown>)
      : {};
  const readFrameValue = (key: string): number => {
    const value = frame[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const readText = (key: string): string | null => {
    const value = node[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  // Only a complete pair of finite coordinates is worth surfacing: half a point
  // would aim taps at (0, y) instead of the control.
  const readActivationPoint = (): DeviceUiPoint | null => {
    const raw = node.activationPoint;
    if (typeof raw !== "object" || raw === null) return null;
    const { x, y } = raw as Record<string, unknown>;
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (typeof y !== "number" || !Number.isFinite(y)) return null;
    return { x, y };
  };
  const identifier = readText("identifier");
  const placeholder = readText("placeholder");
  return {
    role: typeof node.role === "string" ? node.role.slice(0, 128) : "Unknown",
    subrole: clampText(readText("subrole"), 128),
    label: clampText(readText("label"), UI_TEXT_MAX_LENGTH),
    value: clampText(readText("value"), UI_TEXT_MAX_LENGTH),
    frame: {
      x: readFrameValue("x"),
      y: readFrameValue("y"),
      width: Math.max(0, readFrameValue("width")),
      height: Math.max(0, readFrameValue("height")),
    },
    activationPoint: readActivationPoint(),
    ...(identifier === null ? {} : { identifier: clampText(identifier, 512) }),
    enabled: node.enabled !== false,
    ...(node.focused === true ? { focused: true } : {}),
    ...(node.selected === true ? { selected: true } : {}),
    ...(placeholder === null ? {} : { placeholder: clampText(placeholder, UI_TEXT_MAX_LENGTH) }),
    ...(node.unframed === true || typeof node.frame !== "object" ? { unframed: true } : {}),
    children: Array.isArray(node.children) ? node.children.map(normalizeUiNode) : [],
  };
}

/** The contract's per-string cap; a long text view must not fail the whole read. */
const UI_TEXT_MAX_LENGTH = 1_024;

function clampText(value: string | null, maxLength: number): string | null {
  if (value === null || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height live in the IHDR chunk at a fixed offset; no decoder needed. */
export function readPngDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
