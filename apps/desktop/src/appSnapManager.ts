// FILE: appSnapManager.ts
// Purpose: Owns the macOS AppSnap helper lifecycle, permission state, and pending captures.
// Layer: Desktop main-process service
// Depends on: A signed Swift helper plus narrow filesystem/process adapters.

import { stopNativeHelper } from "./stopNativeHelper";

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DesktopAppSnapCapture,
  type DesktopAppSnapErrorEvent,
  type DesktopAppSnapPermission,
  type DesktopAppSnapPermissionGuideState,
  type DesktopAppSnapPermissionKind,
  type DesktopAppSnapPlatform,
  type DesktopAppSnapSettingsPane,
  type DesktopAppSnapShortcut,
  type DesktopAppSnapShortcutAvailability,
  type DesktopAppSnapShortcutUpdateResult,
  type DesktopAppSnapState,
  type DesktopAppSnapWindowEntry,
} from "@synara/contracts";
import {
  DEFAULT_APP_SNAP_SHORTCUT,
  appSnapShortcutAccelerator,
  appSnapShortcutSystemConflict,
  isAppSnapShortcut,
  sameAppSnapShortcut,
} from "@synara/shared/appSnapShortcut";

const MAX_PENDING_CAPTURES = PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
const MAX_HELPER_STDERR_CHARS = 4_096;
const MAX_PENDING_CAPTURE_METADATA_BYTES = 512 * 1024;
const PENDING_CAPTURE_STORAGE_VERSION = 1;
const PENDING_CAPTURE_FILE_PATTERN = /^pending-([a-f0-9]{64})\.json$/;
const PENDING_CAPTURE_IMAGE_PATTERN = /^pending-([a-f0-9]{64})\.png$/;
const HELPER_CAPTURE_IMAGE_PATTERN =
  /^appsnap-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.png$/;
const ORPHANED_PICKER_IMAGE_PATTERN =
  /^appsnap-picker-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;
const LIST_WINDOWS_TIMEOUT_MS = 5_000;
const CAPTURE_WINDOW_TIMEOUT_MS = 20_000;
// Permission checks run through the serialized command queue, so a wedged
// helper must be killed rather than stall every queued read behind it.
const PERMISSION_COMMAND_TIMEOUT_MS = 10_000;
const GUIDE_GRANT_WATCH_MAX_MS = 10 * 60 * 1000;
const MAX_MACOS_WINDOW_ID = 0xffff_ffff;
// Late helper answers to timed-out or interrupted picker requests are dropped
// instead of being consumed as unsolicited hotkey captures.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type AppSnapHelperProcess = ChildProcess.ChildProcessByStdio<Writable | null, Readable, Readable>;
type AppSnapPermissionCommand =
  | "--check-permissions"
  | "--request-permissions"
  | "--prepare-permission-setup";

interface PendingAppSnapCaptureRecord {
  capture: DesktopAppSnapCapture;
  imagePath: string;
  metadataPath: string;
}

interface StoredPendingAppSnapCapture {
  version: typeof PENDING_CAPTURE_STORAGE_VERSION;
  id: string;
  capturedAt: string;
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  sourceAppName: string | null;
  sourceBundleIdentifier: string | null;
  sourceAppIconDataUrl: string | null;
  sourceWindowTitle: string | null;
}

export type AppSnapHelperMessage =
  | {
      type: "permissions";
      accessibility?: "granted" | "denied";
      inputMonitoring?: "granted" | "denied";
      screenRecording?: "granted" | "denied";
    }
  | { type: "ready" }
  | { type: "triggered"; id: string; capturedAt?: string }
  | { type: "escape"; capturedAt?: string }
  | {
      type: "physical-input";
      kind: "keyboard" | "pointer";
      pid?: number;
      windowId?: number;
      capturedAt?: string;
    }
  | { type: "escape-monitor-state"; armed: boolean; capturedAt?: string }
  | {
      type: "captured";
      id: string;
      capturedAt?: string;
      path: string;
      name: string;
      sourceAppName?: string | null;
      sourceBundleIdentifier?: string | null;
      sourceAppIconDataUrl?: string | null;
      sourceWindowTitle?: string | null;
    }
  | { type: "windows"; requestId: string; windows: DesktopAppSnapWindowEntry[] }
  | { type: "permission-guide"; state: DesktopAppSnapPermissionGuideState }
  | {
      type: "release-held-input";
      released?: boolean;
      reason?: string;
      details?: string[];
    }
  | {
      type: "error";
      id?: string;
      code: string;
      message: string;
      capturedAt?: string;
      requestId?: string;
    };

interface PendingAppSnapRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DesktopAppSnapManagerOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  captureDirectory: string;
  excludedBundleId: string;
  appDisplayName?: string;
  appBundlePath?: string;
  onState: (state: DesktopAppSnapState) => void;
  onCaptured: (capture: DesktopAppSnapCapture) => void;
  onError: (error: DesktopAppSnapErrorEvent, focusApp: boolean) => void;
  onPermissionGuideState?: (state: DesktopAppSnapPermissionGuideState) => void;
  now?: () => Date;
  spawn?: typeof ChildProcess.spawn;
  /**
   * Opens System Settings at a privacy pane. Only used by permission setup
   * sessions started inside the manager; renderer-driven guides open the pane
   * through IPC themselves.
   */
  openSettingsPane?: (pane: DesktopAppSnapSettingsPane) => void;
  /**
   * Closes System Settings after a setup session lands every grant. Only used
   * when the session opened Settings itself; a dismissed or timed-out session
   * never closes an app the user may be using for something else.
   */
  closeSettingsApp?: () => void;
  shortcutRegistry?: {
    register: (accelerator: string, callback: () => void) => boolean;
    unregister: (accelerator: string) => void;
  };
}

function normalizeDate(value: unknown, fallback: Date): string {
  if (typeof value !== "string") return fallback.toISOString();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback.toISOString();
}

function normalizeOptionalText(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function normalizeAppIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256_000) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function pendingCaptureStorageKey(captureId: string): string {
  return Crypto.createHash("sha256").update(captureId).digest("hex");
}

function pendingCaptureStoragePaths(
  captureDirectory: string,
  captureId: string,
): { imagePath: string; metadataPath: string } {
  const key = pendingCaptureStorageKey(captureId);
  const basePath = Path.join(captureDirectory, `pending-${key}`);
  return {
    imagePath: `${basePath}.png`,
    metadataPath: `${basePath}.json`,
  };
}

function toStoredPendingCapture(capture: DesktopAppSnapCapture): StoredPendingAppSnapCapture {
  return {
    version: PENDING_CAPTURE_STORAGE_VERSION,
    id: capture.id,
    capturedAt: capture.capturedAt,
    name: capture.name,
    mimeType: "image/png",
    sizeBytes: capture.sizeBytes,
    sourceAppName: capture.sourceAppName,
    sourceBundleIdentifier: capture.sourceBundleIdentifier,
    sourceAppIconDataUrl: capture.sourceAppIconDataUrl,
    sourceWindowTitle: capture.sourceWindowTitle,
  };
}

function parseStoredPendingCapture(value: unknown): StoredPendingAppSnapCapture | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = normalizeOptionalText(candidate.id, 128);
  const name = normalizeOptionalText(candidate.name, 240);
  const capturedAt = normalizeOptionalText(candidate.capturedAt, 128);
  const sizeBytes = candidate.sizeBytes;
  if (
    candidate.version !== PENDING_CAPTURE_STORAGE_VERSION ||
    !id ||
    !name ||
    !capturedAt ||
    !Number.isFinite(Date.parse(capturedAt)) ||
    candidate.mimeType !== "image/png" ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  ) {
    return null;
  }
  return {
    version: PENDING_CAPTURE_STORAGE_VERSION,
    id,
    capturedAt: new Date(capturedAt).toISOString(),
    name,
    mimeType: "image/png",
    sizeBytes,
    sourceAppName: normalizeOptionalText(candidate.sourceAppName),
    sourceBundleIdentifier: normalizeOptionalText(candidate.sourceBundleIdentifier),
    sourceAppIconDataUrl: normalizeAppIconDataUrl(candidate.sourceAppIconDataUrl),
    sourceWindowTitle: normalizeOptionalText(candidate.sourceWindowTitle),
  };
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Buffer> {
  const file = await FS.promises.open(
    filePath,
    FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW | FS.constants.O_NONBLOCK,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Expected a regular file.");
    if (stats.size <= 0) throw new Error("The file is empty.");
    if (stats.size > maximumBytes) throw new Error("The file is larger than allowed.");
    if (expectedBytes !== undefined && stats.size !== expectedBytes) {
      throw new Error("The file size does not match its metadata.");
    }
    const bytes = await file.readFile();
    if (bytes.length !== stats.size) throw new Error("The file changed while it was read.");
    return bytes;
  } finally {
    await file.close();
  }
}

async function readValidatedPendingPng(filePath: string, expectedBytes?: number): Promise<Buffer> {
  const bytes = await readRegularFile(filePath, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, expectedBytes);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("The file is not a valid PNG image.");
  }
  return bytes;
}

async function writePrivateFileAtomically(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Crypto.randomUUID()}`;
  try {
    await FS.promises.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await FS.promises.rename(temporaryPath, filePath);
    await FS.promises.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await FS.promises.unlink(temporaryPath).catch(() => undefined);
  }
}

function isPermission(value: unknown): value is "granted" | "denied" {
  return value === "granted" || value === "denied";
}

export function desktopAppSnapPlatform(platform: NodeJS.Platform): DesktopAppSnapPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

export function parseAppSnapHelperMessage(line: string): AppSnapHelperMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  // The helper reports only the permission kinds it was asked about, so every
  // field is optional; a payload carrying none is not a permissions message.
  if (value.type === "permissions") {
    const permissions: Extract<AppSnapHelperMessage, { type: "permissions" }> = {
      type: "permissions",
      ...(isPermission(value.accessibility) ? { accessibility: value.accessibility } : {}),
      ...(isPermission(value.inputMonitoring) ? { inputMonitoring: value.inputMonitoring } : {}),
      ...(isPermission(value.screenRecording) ? { screenRecording: value.screenRecording } : {}),
    };
    if (
      permissions.accessibility !== undefined ||
      permissions.inputMonitoring !== undefined ||
      permissions.screenRecording !== undefined
    ) {
      return permissions;
    }
    return null;
  }
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "triggered" && typeof value.id === "string" && value.id.length > 0) {
    return {
      type: "triggered",
      id: value.id,
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  if (value.type === "escape") {
    return {
      type: "escape",
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  if (value.type === "escape-monitor-state" && typeof value.armed === "boolean") {
    return {
      type: "escape-monitor-state",
      armed: value.armed,
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  if (value.type === "physical-input" && (value.kind === "keyboard" || value.kind === "pointer")) {
    return {
      type: "physical-input",
      kind: value.kind,
      ...(typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.pid <= 0x7fffffff
        ? { pid: value.pid }
        : {}),
      ...(typeof value.windowId === "number" &&
      Number.isSafeInteger(value.windowId) &&
      value.windowId > 0 &&
      value.windowId <= 0xffffffff
        ? { windowId: value.windowId }
        : {}),
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
    };
  }
  if (
    value.type === "captured" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.name === "string"
  ) {
    return {
      type: "captured",
      id: value.id,
      path: value.path,
      name: value.name,
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
      ...(typeof value.sourceAppName === "string" || value.sourceAppName === null
        ? { sourceAppName: value.sourceAppName }
        : {}),
      ...(typeof value.sourceBundleIdentifier === "string" || value.sourceBundleIdentifier === null
        ? { sourceBundleIdentifier: value.sourceBundleIdentifier }
        : {}),
      ...(typeof value.sourceAppIconDataUrl === "string" || value.sourceAppIconDataUrl === null
        ? { sourceAppIconDataUrl: value.sourceAppIconDataUrl }
        : {}),
      ...(typeof value.sourceWindowTitle === "string" || value.sourceWindowTitle === null
        ? { sourceWindowTitle: value.sourceWindowTitle }
        : {}),
    };
  }
  if (
    value.type === "error" &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
      ...(typeof value.capturedAt === "string" ? { capturedAt: value.capturedAt } : {}),
      ...(typeof value.requestId === "string" && value.requestId.length > 0
        ? { requestId: value.requestId }
        : {}),
    };
  }
  if (
    value.type === "windows" &&
    typeof value.requestId === "string" &&
    Array.isArray(value.windows)
  ) {
    const windows: DesktopAppSnapWindowEntry[] = [];
    for (const candidate of value.windows) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Record<string, unknown>;
      if (
        typeof entry.windowId !== "number" ||
        !Number.isInteger(entry.windowId) ||
        entry.windowId <= 0 ||
        entry.windowId > MAX_MACOS_WINDOW_ID
      ) {
        continue;
      }
      windows.push({
        windowId: entry.windowId,
        appName: normalizeOptionalText(entry.appName),
        bundleIdentifier: normalizeOptionalText(entry.bundleIdentifier),
        windowTitle: normalizeOptionalText(entry.windowTitle),
        appIconDataUrl: normalizeAppIconDataUrl(entry.appIconDataUrl),
      });
    }
    return { type: "windows", requestId: value.requestId, windows };
  }
  if (
    value.type === "permission-guide" &&
    (value.state === "closed" || value.state === "granted")
  ) {
    return { type: "permission-guide", state: value.state };
  }
  return null;
}

export function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = Path.relative(Path.resolve(directory), Path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${Path.sep}`) && relative !== "..";
}

function permissionRequiredMessage(permissions: {
  accessibility?: DesktopAppSnapPermission | undefined;
  inputMonitoring: DesktopAppSnapPermission;
  screenRecording: DesktopAppSnapPermission;
}): string {
  const missing: string[] = [];
  if (permissions.accessibility !== undefined && permissions.accessibility !== "granted") {
    missing.push("Accessibility");
  }
  if (permissions.inputMonitoring !== "granted") missing.push("Input Monitoring");
  if (permissions.screenRecording !== "granted") missing.push("Screen Recording");
  return `Allow ${missing.join(" and ")} in macOS System Settings, then try again.`;
}

const APP_SNAP_PERMISSION_KIND_GUIDE_PANES: Record<
  DesktopAppSnapPermissionKind,
  DesktopAppSnapSettingsPane
> = {
  accessibility: "accessibility",
  inputMonitoring: "input-monitoring",
  screenRecording: "screen-recording",
};

// Setup sessions walk panes in this order; the queue build sorts and dedupes
// into it so callers can pass kinds in any order without respawning a pane.
const APP_SNAP_PERMISSION_SETUP_ORDER: readonly DesktopAppSnapPermissionKind[] = [
  "accessibility",
  "inputMonitoring",
  "screenRecording",
];

// The helper defaults to this set when no --permission selectors are passed,
// so the legacy check can keep running against helpers that predate the flag.
const APP_SNAP_LEGACY_PERMISSION_KINDS: readonly DesktopAppSnapPermissionKind[] = [
  "inputMonitoring",
  "screenRecording",
];

function isLegacyPermissionSet(permissions: readonly DesktopAppSnapPermissionKind[]): boolean {
  return (
    permissions.length === APP_SNAP_LEGACY_PERMISSION_KINDS.length &&
    APP_SNAP_LEGACY_PERMISSION_KINDS.every((kind) => permissions.includes(kind))
  );
}

const APP_SNAP_GUIDE_PANE_PERMISSION_KINDS: Record<
  DesktopAppSnapSettingsPane,
  DesktopAppSnapPermissionKind
> = {
  accessibility: "accessibility",
  "input-monitoring": "inputMonitoring",
  "screen-recording": "screenRecording",
};

function isPermissionErrorCode(code: string): boolean {
  return (
    code === "input-monitoring-required" ||
    code === "screen-recording-required" ||
    code === "permission-required"
  );
}

function isBenignCaptureErrorCode(code: string): boolean {
  return code === "capture_in_progress" || code === "capture-in-progress";
}

export class DesktopAppSnapManager {
  readonly #options: Required<Pick<DesktopAppSnapManagerOptions, "now" | "spawn">> &
    Omit<
      DesktopAppSnapManagerOptions,
      "now" | "spawn" | "appDisplayName" | "appBundlePath" | "onPermissionGuideState"
    > & {
      appDisplayName: string;
      appBundlePath: string;
      onPermissionGuideState: (state: DesktopAppSnapPermissionGuideState) => void;
    };
  readonly #platform: DesktopAppSnapPlatform;
  #enabled = false;
  // Accessibility is only tracked once a caller includes it in a check; before
  // that the AppSnap state must not pretend to know anything about it.
  #accessibilityPermission: DesktopAppSnapPermission | undefined = undefined;
  #inputMonitoringPermission: DesktopAppSnapPermission = "unknown";
  #screenRecordingPermission: DesktopAppSnapPermission = "unknown";
  #status: DesktopAppSnapState["status"];
  #message: string | null;
  #watchProcess: AppSnapHelperProcess | null = null;
  #watchOutputLines: Readline.Interface | null = null;
  #watchReconcilePromise: Promise<void> | null = null;
  #watchReconcileRequested = false;
  #permissionProcess: AppSnapHelperProcess | null = null;
  #permissionCommandQueue: Promise<void> = Promise.resolve();
  // Read-side freshness only: a grant flip surfaces at the next expiry, and
  // request/setup paths always bypass it. Five seconds keeps a TCC answer
  // honest for display while skipping a helper spawn on every poll.
  readonly #permissionCheckCache = new Map<DesktopAppSnapPermissionKind, number>();
  readonly #permissionChecks = new Map<string, Promise<boolean>>();
  // An explicit setup failure survives passive grant/health refreshes until
  // another explicit attempt or app restart; it must not become endless waiting.
  #permissionSetupFailure: {
    code: NonNullable<DesktopAppSnapState["permissionSetupErrorCode"]>;
    message: string;
  } | null = null;
  #disposed = false;
  #requestedCapture: { id: string; cancel: () => void } | null = null;
  #intentionalWatchStop = false;
  #pendingCaptures: PendingAppSnapCaptureRecord[] = [];
  #pendingCapturesLoadPromise: Promise<void> | null = null;
  #captureReadQueue: Promise<void> = Promise.resolve();
  #shortcut: DesktopAppSnapShortcut = DEFAULT_APP_SNAP_SHORTCUT;
  #registeredAccelerator: string | null = null;
  #pendingWindowRequests = new Map<string, PendingAppSnapRequest<DesktopAppSnapWindowEntry[]>>();
  #pendingCaptureRequests = new Map<string, PendingAppSnapRequest<DesktopAppSnapCapture>>();
  #timedOutCaptureRequestIds = new Set<string>();
  #guideProcess: AppSnapHelperProcess | null = null;
  #guideOutputLines: Readline.Interface | null = null;
  #lastGuideState: DesktopAppSnapPermissionGuideState | null = null;
  // The coach's own grant check runs inside the long-lived guide helper, and
  // macOS never lets a running process observe a fresh Accessibility grant —
  // so the manager re-checks through a newly spawned helper on a timer and
  // closes the coach itself when the pane flips.
  #activeGuidePane: DesktopAppSnapSettingsPane | null = null;
  #guideGrantWatch: {
    child: AppSnapHelperProcess;
    timer: NodeJS.Timeout;
    startedAt: number;
    pending: boolean;
  } | null = null;
  // A setup session guides each missing pane in turn. A renderer-driven guide
  // leaves this queue empty, so its close never spawns a follow-on coach.
  #guidePaneQueue: DesktopAppSnapSettingsPane[] = [];
  #guideSessionKinds: readonly DesktopAppSnapPermissionKind[] = [];
  #guideSessionGeneration = 0;
  #lastEmittedStateJson: string | null = null;
  #guideSessionOpensSettings = false;
  // Whether this session opened System Settings at least once. Only then may
  // a successful drain close it again; a renderer-driven guide or a session
  // that never reached a pane leaves the user's Settings alone.
  #guideSessionOpenedSettings = false;

  constructor(options: DesktopAppSnapManagerOptions) {
    this.#options = {
      ...options,
      appDisplayName: options.appDisplayName ?? "",
      appBundlePath: options.appBundlePath ?? "",
      onPermissionGuideState: options.onPermissionGuideState ?? (() => undefined),
      now: options.now ?? (() => new Date()),
      spawn: options.spawn ?? ChildProcess.spawn,
    };
    this.#platform = desktopAppSnapPlatform(options.platform);
    this.#status = this.#platform === "macos" ? "disabled" : "unsupported";
    this.#message =
      this.#platform === "macos" ? null : "AppSnap is available only in the macOS desktop app.";
  }

  getState(): DesktopAppSnapState {
    return {
      platform: this.#platform,
      supported: this.#platform === "macos",
      enabled: this.#enabled,
      status: this.#permissionSetupFailure ? "error" : this.#status,
      shortcut: this.#platform === "macos" ? this.#shortcut : null,
      inputMonitoringPermission: this.#inputMonitoringPermission,
      screenRecordingPermission: this.#screenRecordingPermission,
      ...(this.#accessibilityPermission !== undefined
        ? { accessibilityPermission: this.#accessibilityPermission }
        : {}),
      message: this.#permissionSetupFailure?.message ?? this.#message,
      ...(this.#permissionSetupFailure
        ? { permissionSetupErrorCode: this.#permissionSetupFailure.code }
        : {}),
      appDisplayName: this.#options.appDisplayName,
    };
  }

  async refreshState(
    permissions?: readonly DesktopAppSnapPermissionKind[],
    options: { readonly force?: boolean } = {},
  ): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (!(await this.#runPermissionCommand("--check-permissions", permissions, !options.force))) {
      return this.getState();
    }
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async setEnabled(enabled: boolean): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    this.#enabled = enabled;
    if (!enabled) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("disabled", null);
      return this.getState();
    }
    if (!(await this.#runPermissionCommand("--check-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  checkShortcut(shortcut: unknown): DesktopAppSnapShortcutAvailability {
    if (this.#platform !== "macos") {
      return { available: false, reason: "AppSnap shortcuts are available only on macOS." };
    }
    if (!isAppSnapShortcut(shortcut)) {
      return {
        available: false,
        reason: "Choose one modifier and one supported keyboard key.",
      };
    }
    if (shortcut.kind === "both-option-keys") {
      return { available: true, reason: null };
    }
    const systemConflict = appSnapShortcutSystemConflict(shortcut);
    if (systemConflict) {
      return { available: false, reason: systemConflict };
    }

    const accelerator = appSnapShortcutAccelerator(shortcut);
    if (this.#registeredAccelerator === accelerator) {
      return { available: true, reason: null };
    }
    const registry = this.#options.shortcutRegistry;
    if (!registry) {
      return { available: false, reason: "Global shortcut checks are unavailable." };
    }
    try {
      if (!registry.register(accelerator, () => undefined)) {
        return {
          available: false,
          reason: "macOS or another app is already using this shortcut.",
        };
      }
      registry.unregister(accelerator);
      return { available: true, reason: null };
    } catch {
      return { available: false, reason: "macOS could not register this shortcut." };
    }
  }

  /**
   * Adopts any well-formed shortcut, even one the availability probe rejects:
   * a persisted chord that another app grabbed since last launch must surface
   * as an error state from reconciliation, not silently keep the old chord.
   */
  async setShortcut(shortcut: unknown): Promise<DesktopAppSnapShortcutUpdateResult> {
    const availability = this.checkShortcut(shortcut);
    if (
      this.#platform !== "macos" ||
      !isAppSnapShortcut(shortcut) ||
      sameAppSnapShortcut(this.#shortcut, shortcut)
    ) {
      return { state: this.getState(), availability };
    }

    this.#stopWatchProcess();
    this.#releaseShortcutReservation();
    this.#shortcut = shortcut;
    if (this.#enabled) await this.#reconcileWatchProcess();
    this.#emitState();
    return { state: this.getState(), availability };
  }

  async requestPermissions(
    permissions?: readonly DesktopAppSnapPermissionKind[],
  ): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    this.#permissionSetupFailure = null;
    this.#permissionCheckCache.clear();
    if (!(await this.#runPermissionCommand("--request-permissions", permissions))) {
      return this.getState();
    }
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  /**
   * Backend-driven permission setup: check the requested kinds, then walk the
   * floating guide through each pane still missing a grant, opening System
   * Settings at that pane as each step begins. The guide advances itself —
   * when a fresh check reports a grant, the next missing pane's coach and
   * settings page take over without the user returning to Synara, and when
   * every grant lands the session closes the Settings it opened.
   *
   * No macOS permission prompt is raised here on purpose: the prompt adds the
   * app with its switch off and cannot be re-raised once denied, while the
   * guide uses the pane's toggle or supported drag-and-drop. Registration must
   * first resolve this exact running app. Prompt args from tools never reach a
   * request path either.
   */
  async startPermissionSetup(
    permissions: readonly DesktopAppSnapPermissionKind[],
  ): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (permissions.length === 0) return this.getState();
    this.hidePermissionGuide();
    const generation = this.#guideSessionGeneration;
    this.#permissionSetupFailure = null;
    this.#permissionCheckCache.clear();
    // Explicit registration preflight plus a grant check, with no TCC mutation
    // or permission prompt. Unresolvable copies never start a polling coach.
    if (
      !(await this.#runPermissionCommand(
        "--prepare-permission-setup",
        permissions,
        false,
        generation,
      ))
    ) {
      return this.getState();
    }
    if (this.#disposed || generation !== this.#guideSessionGeneration) return this.getState();
    this.#guidePaneQueue = [...new Set(permissions)]
      .sort(
        (left, right) =>
          APP_SNAP_PERMISSION_SETUP_ORDER.indexOf(left) -
          APP_SNAP_PERMISSION_SETUP_ORDER.indexOf(right),
      )
      .map((kind) => APP_SNAP_PERMISSION_KIND_GUIDE_PANES[kind]);
    this.#guideSessionKinds = [...permissions];
    this.#guideSessionOpensSettings = true;
    this.#guideSessionOpenedSettings = false;
    this.#advancePermissionGuide();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async listPendingCaptures(): Promise<DesktopAppSnapCapture[]> {
    await this.#ensurePendingCapturesLoaded();
    return this.#pendingCaptures.map(({ capture }) => ({
      ...capture,
      bytes: new Uint8Array(capture.bytes),
    }));
  }

  async acknowledgeCapture(captureId: string): Promise<void> {
    if (captureId.trim().length === 0) return;
    await this.#ensurePendingCapturesLoaded();
    const matchingRecords = this.#pendingCaptures.filter(({ capture }) => capture.id === captureId);
    for (const record of matchingRecords) {
      await this.#deletePendingCaptureFiles(record);
    }
    this.#pendingCaptures = this.#pendingCaptures.filter(({ capture }) => capture.id !== captureId);
  }

  async listWindows(): Promise<DesktopAppSnapWindowEntry[]> {
    const child = this.#requireWatchProcess();
    const requestId = Crypto.randomUUID();
    return await new Promise<DesktopAppSnapWindowEntry[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingWindowRequests.delete(requestId);
        reject(new Error("Timed out while listing capturable windows."));
      }, LIST_WINDOWS_TIMEOUT_MS);
      this.#pendingWindowRequests.set(requestId, { resolve, reject, timer });
      try {
        child.stdin?.write(`list-windows ${requestId}\n`);
      } catch {
        this.#settleWindowRequest(requestId, null, new Error("AppSnap is not listening."));
      }
    });
  }

  async captureWindow(windowId: number): Promise<DesktopAppSnapCapture> {
    if (!Number.isInteger(windowId) || windowId <= 0 || windowId > MAX_MACOS_WINDOW_ID) {
      throw new Error("captureWindow requires a valid macOS window id.");
    }
    const child = this.#requireWatchProcess();
    // The prefix keeps a request-driven helper file distinguishable from an
    // unsolicited hotkey capture after a crash. Picker requests have already
    // lost their caller after restart and must not be auto-attached elsewhere.
    const requestId = `picker-${Crypto.randomUUID()}`;
    return await new Promise<DesktopAppSnapCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCaptureRequests.delete(requestId);
        this.#tombstoneCaptureRequest(requestId);
        reject(new Error("Timed out while capturing the requested window."));
      }, CAPTURE_WINDOW_TIMEOUT_MS);
      this.#pendingCaptureRequests.set(requestId, { resolve, reject, timer });
      try {
        child.stdin?.write(`capture-window ${requestId} ${windowId}\n`);
      } catch {
        this.#settleCaptureRequest(requestId, null, new Error("AppSnap is not listening."));
      }
    });
  }

  showPermissionGuide(pane: DesktopAppSnapSettingsPane): void {
    // A renderer-driven guide covers exactly one pane and never auto-advances:
    // any in-flight setup session ends when the renderer takes over the coach.
    // No OS prompt is raised: the inline steps plus the coach are the whole
    // flow, and a denied prompt cannot be re-raised.
    this.#finishGuideSession(false);
    this.#permissionSetupFailure = null;
    this.#spawnPermissionGuide(pane);
  }

  /**
   * Ends a setup session. A successful drain closes the System Settings the
   * session opened; every other ending (dismissal, timeout, renderer takeover,
   * spawn failure) leaves Settings alone.
   */
  #finishGuideSession(success: boolean): void {
    this.#guideSessionGeneration += 1;
    const shouldCloseSettings = success && this.#guideSessionOpenedSettings;
    this.#guidePaneQueue = [];
    this.#guideSessionKinds = [];
    this.#guideSessionOpensSettings = false;
    this.#guideSessionOpenedSettings = false;
    if (shouldCloseSettings) {
      try {
        this.#options.closeSettingsApp?.();
      } catch {
        // Best effort: the grants already landed; a lingering Settings window
        // is an annoyance, not a broken setup.
      }
    }
  }

  #spawnPermissionGuide(pane: DesktopAppSnapSettingsPane): void {
    if (this.#platform !== "macos" || this.#disposed) return;
    if (!FS.existsSync(this.#options.helperPath)) return;
    this.#stopGuideProcess();
    try {
      const child = this.#options.spawn(
        this.#options.helperPath,
        [
          "--permission-guide",
          "--pane",
          pane,
          "--app-path",
          this.#options.appBundlePath,
          "--app-name",
          this.#options.appDisplayName,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      // A helper that dies mid-write must not surface as an unhandled stream error.
      child.stdin?.on("error", () => undefined);
      this.#guideProcess = child;
      this.#activeGuidePane = pane;
      this.#lastGuideState = null;
      this.#startGuideGrantWatch(child);
      child.once("error", () => {
        if (this.#guideProcess !== child) return;
        this.#guideProcess = null;
        this.#activeGuidePane = null;
        this.#stopGuideGrantWatch(child);
        this.#guideOutputLines?.close();
        this.#guideOutputLines = null;
        this.#lastGuideState = "closed";
        this.#options.onPermissionGuideState("closed");
        this.#finishGuideSession(false);
      });
      this.#guideOutputLines = this.#wireHelperOutput(child, (message) =>
        this.#handleGuideMessage(child, message),
      );
      child.once("exit", () => {
        this.#stopGuideGrantWatch(child);
      });
      // An exiting helper can still have a final structured setup error in
      // stdout. Drain it before disposing the reader or advancing the guide.
      child.once("close", () => {
        if (this.#guideProcess !== child) return;
        this.#guideProcess = null;
        this.#activeGuidePane = null;
        this.#stopGuideGrantWatch(child);
        this.#guideOutputLines?.close();
        this.#guideOutputLines = null;
        const finalState = this.#lastGuideState;
        // Crash or external kill: report closed so the renderer guide stays honest.
        if (finalState !== "closed" && finalState !== "granted") {
          this.#lastGuideState = "closed";
          this.#options.onPermissionGuideState("closed");
        }
        if (this.#guidePaneQueue.length === 0) return;
        if (finalState !== "granted") {
          // A dismissed (or crashed) coach ends the setup session rather than
          // respawning panes the user just waved away.
          this.#finishGuideSession(false);
          return;
        }
        // Recheck before advancing so a pane the user already flipped while the
        // last coach was up never shows a stale guide of its own. A failed
        // recheck ends the session rather than advancing on stale fields.
        const sessionKinds = this.#guideSessionKinds;
        const generation = this.#guideSessionGeneration;
        void this.#runPermissionCommand("--check-permissions", sessionKinds)
          .then((ok) => {
            if (generation !== this.#guideSessionGeneration || this.#disposed) return;
            if (ok) {
              this.#advancePermissionGuide();
              return;
            }
            this.#finishGuideSession(false);
          })
          .catch(() => {
            if (generation === this.#guideSessionGeneration) this.#finishGuideSession(false);
          });
      });
    } catch {
      // The guide is best-effort; the inline steps remain usable without it.
    }
  }

  #panePermission(pane: DesktopAppSnapSettingsPane): DesktopAppSnapPermission | undefined {
    switch (pane) {
      case "accessibility":
        return this.#accessibilityPermission;
      case "input-monitoring":
        return this.#inputMonitoringPermission;
      case "screen-recording":
        return this.#screenRecordingPermission;
    }
  }

  // Advances a setup session to the first queued pane still missing its grant.
  #advancePermissionGuide(): void {
    while (
      this.#guidePaneQueue.length > 0 &&
      this.#panePermission(this.#guidePaneQueue[0]!) === "granted"
    ) {
      this.#guidePaneQueue.shift();
    }
    const pane = this.#guidePaneQueue[0];
    if (!pane) {
      // Every queued grant landed: close the Settings this session opened.
      // When nothing was ever queued (all granted up front) the opened flag
      // is false, so a no-op setup closes nothing.
      this.#finishGuideSession(true);
      return;
    }
    if (this.#guideSessionOpensSettings && this.#options.openSettingsPane) {
      try {
        this.#options.openSettingsPane(pane);
      } catch {
        // The coach still follows System Settings when it opens by itself.
      }
      this.#guideSessionOpenedSettings = true;
    }
    this.#spawnPermissionGuide(pane);
  }

  hidePermissionGuide(): void {
    this.#finishGuideSession(false);
    this.#stopGuideProcess();
  }

  #stopGuideProcess(): void {
    const child = this.#guideProcess;
    if (!child) return;
    this.#guideProcess = null;
    this.#activeGuidePane = null;
    this.#stopGuideGrantWatch(child);
    this.#guideOutputLines?.close();
    this.#guideOutputLines = null;
    try {
      child.stdin?.write("close\n");
    } catch {
      // Fall through to the kill below.
    }
    setTimeout(() => {
      child.kill("SIGTERM");
    }, 500).unref();
  }

  /**
   * Polls the guide pane's grant through a freshly spawned helper on each tick:
   * the coach's own in-process check can never see a new Accessibility grant,
   * so without this the coach would stay up after the user flips the toggle.
   * Every tick also re-emits the permission snapshot, which keeps the renderer
   * badges live while a guide is on screen.
   * The grant watch polls every 800ms; dedupe keeps a steady-state guide from
   * spamming unchanged snapshots over IPC on every tick.
   */
  #startGuideGrantWatch(child: AppSnapHelperProcess): void {
    this.#stopGuideGrantWatch();
    const timer = setInterval(() => {
      const watch = this.#guideGrantWatch;
      if (this.#guideProcess !== child || !watch || watch.child !== child) {
        this.#stopGuideGrantWatch(child);
        return;
      }
      if (Date.now() - watch.startedAt >= GUIDE_GRANT_WATCH_MAX_MS) {
        this.#stopGuideGrantWatch(child);
        this.#lastGuideState = "closed";
        this.#options.onPermissionGuideState("closed");
        this.#finishGuideSession(false);
        this.#emitState();
        this.#stopGuideProcess();
        return;
      }
      if (watch.pending) return;
      const pane = this.#activeGuidePane;
      if (!pane) return;
      const kinds =
        this.#guideSessionKinds.length > 0
          ? this.#guideSessionKinds
          : [APP_SNAP_GUIDE_PANE_PERMISSION_KINDS[pane]];
      watch.pending = true;
      void this.#runPermissionCommand("--check-permissions", kinds)
        .then((ok) => {
          if (!ok || this.#guideProcess !== child || this.#activeGuidePane !== pane) return;
          if (this.#panePermission(pane) !== "granted") return;
          this.#onGuidePaneGranted(child);
        })
        .catch(() => undefined)
        .finally(() => {
          const latest = this.#guideGrantWatch;
          if (latest && latest.child === child) latest.pending = false;
        });
    }, 800);
    timer.unref();
    this.#guideGrantWatch = { child, timer, startedAt: Date.now(), pending: false };
  }

  #stopGuideGrantWatch(child?: AppSnapHelperProcess): void {
    const watch = this.#guideGrantWatch;
    if (!watch) return;
    if (child && watch.child !== child) return;
    clearInterval(watch.timer);
    this.#guideGrantWatch = null;
  }

  /**
   * The watch saw the active pane grant while the coach was still up: report
   * the grant, retire the coach, and carry a setup session to its next pane.
   * `#stopGuideProcess` nulls `#guideProcess` before the child exits, so the
   * exit handler will not advance the session — this method does it instead.
   */
  #onGuidePaneGranted(child: AppSnapHelperProcess): void {
    if (this.#guideProcess !== child) return;
    this.#stopGuideGrantWatch(child);
    this.#lastGuideState = "granted";
    this.#options.onPermissionGuideState("granted");
    this.#stopGuideProcess();
    if (this.#guidePaneQueue.length === 0) return;
    const sessionKinds = this.#guideSessionKinds;
    const generation = this.#guideSessionGeneration;
    void this.#runPermissionCommand("--check-permissions", sessionKinds)
      .then((ok) => {
        if (generation !== this.#guideSessionGeneration || this.#disposed) return;
        if (ok) {
          this.#advancePermissionGuide();
          return;
        }
        this.#finishGuideSession(false);
      })
      .catch(() => {
        if (generation === this.#guideSessionGeneration) this.#finishGuideSession(false);
      });
  }

  #handleGuideMessage(child: AppSnapHelperProcess, message: AppSnapHelperMessage): void {
    if (this.#guideProcess !== child) return;
    if (message.type === "error") {
      this.#recordPermissionSetupFailure(message);
      return;
    }
    if (message.type !== "permission-guide") return;
    this.#lastGuideState = message.state;
    this.#options.onPermissionGuideState(message.state);
  }

  #recordPermissionSetupFailure(message: Extract<AppSnapHelperMessage, { type: "error" }>): void {
    const code = message.code;
    if (
      code !== "permission_setup_bundle_unavailable" &&
      code !== "permission_setup_registration_unresolved" &&
      code !== "permission_setup_identity_mismatch"
    )
      return;
    this.#permissionSetupFailure = { code, message: message.message };
    this.#permissionCheckCache.clear();
    this.#finishGuideSession(false);
    this.#stopGuideProcess();
    this.#lastGuideState = "closed";
    this.#options.onPermissionGuideState("closed");
    this.#setState("error", message.message);
    this.#options.onError(
      {
        code: message.code,
        message: message.message,
        capturedAt: this.#options.now().toISOString(),
      },
      true,
    );
  }

  #requireWatchProcess(): AppSnapHelperProcess {
    const child = this.#watchProcess;
    if (!child || this.#disposed || !this.#enabled) {
      throw new Error("AppSnap is not listening.");
    }
    return child;
  }

  #settleWindowRequest(
    requestId: string,
    windows: DesktopAppSnapWindowEntry[] | null,
    error?: Error,
  ): void {
    const request = this.#pendingWindowRequests.get(requestId);
    if (!request) return;
    this.#pendingWindowRequests.delete(requestId);
    clearTimeout(request.timer);
    if (error) {
      request.reject(error);
    } else {
      request.resolve(windows ?? []);
    }
  }

  #settleCaptureRequest(
    requestId: string,
    capture: DesktopAppSnapCapture | null,
    error?: Error,
  ): boolean {
    const request = this.#pendingCaptureRequests.get(requestId);
    if (!request) return false;
    this.#pendingCaptureRequests.delete(requestId);
    clearTimeout(request.timer);
    if (error) {
      request.reject(error);
    } else if (capture) {
      request.resolve(capture);
    } else {
      request.reject(new Error("The AppSnap helper returned no capture."));
    }
    return true;
  }
  // Timed-out request ids are tombstoned for the lifetime of the manager: a
  // late capture for them must always be dropped, never consumed as a hotkey
  // capture. The set stays tiny (timeouts are rare) and is cleared on dispose.
  #tombstoneCaptureRequest(requestId: string): void {
    this.#timedOutCaptureRequestIds.add(requestId);
  }

  async #dropLateRequestCapture(
    message: Extract<AppSnapHelperMessage, { type: "captured" }>,
  ): Promise<void> {
    const capturePath = Path.resolve(message.path);
    if (!isPathInsideDirectory(this.#options.captureDirectory, capturePath)) {
      return;
    }
    await FS.promises.unlink(capturePath).catch(() => undefined);
  }

  #rejectPendingRequests(message: string): void {
    const windowRequests = [...this.#pendingWindowRequests.values()];
    const captureRequests = [...this.#pendingCaptureRequests.entries()];
    this.#pendingWindowRequests.clear();
    this.#pendingCaptureRequests.clear();
    for (const request of windowRequests) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    for (const [requestId, request] of captureRequests) {
      clearTimeout(request.timer);
      this.#tombstoneCaptureRequest(requestId);
      request.reject(new Error(message));
    }
  }

  /** Explicit read-only request. Independent of shortcut enablement and Input Monitoring. */
  async captureCurrentApp(requestId: string): Promise<DesktopAppSnapCapture> {
    if (this.#disposed || this.#platform !== "macos") throw new Error("AppSnap is unavailable.");
    if (this.#requestedCapture) throw new Error("An AppSnap request is already in progress.");
    let cancelled = false;
    let cancelChild: (() => void) | undefined;
    const request = {
      id: requestId,
      cancel: () => {
        cancelled = true;
        cancelChild?.();
      },
    };
    this.#requestedCapture = request;
    let directory: string | undefined;
    let capture: DesktopAppSnapCapture;
    const processState: { child: AppSnapHelperProcess | undefined; exited: boolean } = {
      child: undefined,
      exited: false,
    };
    const cleanup = async () => {
      try {
        if (directory) await FS.promises.rm(directory, { recursive: true, force: true });
      } finally {
        if (this.#requestedCapture === request) this.#requestedCapture = null;
      }
    };
    try {
      await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
      directory = await FS.promises.mkdtemp(
        Path.join(this.#options.captureDirectory, "requested-"),
      );
      if (cancelled) throw new Error("AppSnap request cancelled.");
      const outputDirectory = directory;
      capture = await new Promise<DesktopAppSnapCapture>((resolve, reject) => {
        const child = this.#options.spawn(
          this.#options.helperPath,
          [
            "--watch",
            "--external-trigger",
            "--output-dir",
            outputDirectory,
            "--excluded-bundle-id",
            this.#options.excludedBundleId,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        processState.child = child;
        child.once("exit", () => {
          processState.exited = true;
        });
        child.once("close", () => {
          processState.exited = true;
        });
        let settled = false;
        let reading = false;
        const finish = (error?: Error, capture?: DesktopAppSnapCapture) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          lines.close();
          if (error) reject(error);
          else if (capture) resolve(capture);
        };
        const timeout = setTimeout(() => finish(new Error("AppSnap capture timed out.")), 10_000);
        const lines = this.#wireHelperOutput(child, (message) => {
          if (settled) return;
          if (message.type === "ready") child.stdin?.write("trigger\n");
          if (message.type === "error") finish(new Error(message.message));
          if (message.type !== "captured" || reading) return;
          reading = true;
          void (async () => {
            const capturePath = Path.resolve(message.path);
            if (!isPathInsideDirectory(outputDirectory, capturePath))
              throw new Error("Invalid AppSnap capture path.");
            const bytes = await readValidatedPendingPng(capturePath);
            finish(undefined, {
              id: message.id,
              capturedAt: normalizeDate(message.capturedAt, this.#options.now()),
              name: message.name,
              mimeType: "image/png",
              sizeBytes: bytes.byteLength,
              bytes,
              sourceAppName: normalizeOptionalText(message.sourceAppName),
              sourceBundleIdentifier: normalizeOptionalText(message.sourceBundleIdentifier),
              sourceAppIconDataUrl: null,
              sourceWindowTitle: normalizeOptionalText(message.sourceWindowTitle),
            });
          })().catch((error: unknown) =>
            finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
        child.stdin?.on("error", () => finish(new Error("AppSnap helper disconnected.")));
        child.once("error", (error) => finish(error));
        child.once("exit", () => {
          if (!reading) finish(new Error("AppSnap helper stopped before capture."));
        });
        cancelChild = () => finish(new Error("AppSnap request cancelled."));
        if (cancelled) cancelChild();
      });
    } finally {
      try {
        if (processState.child)
          await stopNativeHelper(processState.child, () => processState.exited);
      } finally {
        if (!processState.child || processState.exited) await cleanup();
        else {
          // Do not free the lane or delete files while a helper still owns them.
          // Even a failed bounded shutdown can recover on its eventual exit.
          const recover = () => {
            processState.child?.removeListener("exit", recover);
            processState.child?.removeListener("close", recover);
            void cleanup().catch((error: unknown) =>
              console.warn("[desktop-appsnap] Request cleanup failed", error),
            );
          };
          processState.child.once("exit", recover);
          processState.child.once("close", recover);
        }
      }
    }
    if (cancelled) throw new Error("AppSnap request cancelled.");
    return capture;
  }

  cancelCapture(requestId: string): void {
    if (this.#requestedCapture?.id === requestId) this.#requestedCapture.cancel();
  }

  dispose(): void {
    this.#disposed = true;
    this.#requestedCapture?.cancel();
    this.#stopWatchProcess();
    this.#stopGuideProcess();
    this.#finishGuideSession(false);
    this.#releaseShortcutReservation();
    this.#permissionProcess?.kill("SIGTERM");
    this.#permissionProcess = null;
    this.#pendingCaptures = [];
    this.#timedOutCaptureRequestIds.clear();
  }

  async #ensurePendingCapturesLoaded(): Promise<void> {
    if (!this.#pendingCapturesLoadPromise) {
      this.#pendingCapturesLoadPromise = this.#loadPendingCaptures();
    }
    const loadPromise = this.#pendingCapturesLoadPromise;
    try {
      await loadPromise;
    } catch (error) {
      if (this.#pendingCapturesLoadPromise === loadPromise) {
        this.#pendingCapturesLoadPromise = null;
      }
      throw error;
    }
  }

  async #loadPendingCaptures(): Promise<void> {
    await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
    await FS.promises.chmod(this.#options.captureDirectory, 0o700).catch(() => undefined);
    const entries = await FS.promises.readdir(this.#options.captureDirectory);
    const records: PendingAppSnapCaptureRecord[] = [];
    const metadataStorageKeys = new Set(
      entries.flatMap((entry) => PENDING_CAPTURE_FILE_PATTERN.exec(entry)?.[1] ?? []),
    );

    for (const entry of entries) {
      const imageStorageKey = PENDING_CAPTURE_IMAGE_PATTERN.exec(entry)?.[1];
      if (!imageStorageKey || metadataStorageKeys.has(imageStorageKey)) continue;
      await FS.promises
        .unlink(Path.join(this.#options.captureDirectory, entry))
        .catch(() => undefined);
    }

    // A picker capture belongs to the renderer request that initiated it. If
    // the desktop process crashed before consuming the helper output, there is
    // no safe target thread to recover it into on the next launch.
    for (const entry of entries) {
      if (!ORPHANED_PICKER_IMAGE_PATTERN.test(entry)) continue;
      await FS.promises
        .unlink(Path.join(this.#options.captureDirectory, entry))
        .catch(() => undefined);
    }

    for (const entry of entries) {
      const match = PENDING_CAPTURE_FILE_PATTERN.exec(entry);
      if (!match) continue;
      const storageKey = match[1];
      const metadataPath = Path.join(this.#options.captureDirectory, entry);
      const imagePath = Path.join(this.#options.captureDirectory, `pending-${storageKey}.png`);
      try {
        const metadataBytes = await readRegularFile(
          metadataPath,
          MAX_PENDING_CAPTURE_METADATA_BYTES,
        );
        const stored = parseStoredPendingCapture(JSON.parse(metadataBytes.toString("utf8")));
        if (!stored || pendingCaptureStorageKey(stored.id) !== storageKey) {
          throw new Error("Pending AppSnap metadata is invalid.");
        }
        const bytes = await readValidatedPendingPng(imagePath, stored.sizeBytes);
        records.push({
          capture: {
            id: stored.id,
            capturedAt: stored.capturedAt,
            name: stored.name,
            mimeType: stored.mimeType,
            sizeBytes: bytes.byteLength,
            bytes: new Uint8Array(bytes),
            sourceAppName: stored.sourceAppName,
            sourceBundleIdentifier: stored.sourceBundleIdentifier,
            sourceAppIconDataUrl: stored.sourceAppIconDataUrl,
            sourceWindowTitle: stored.sourceWindowTitle,
          },
          imagePath,
          metadataPath,
        });
      } catch (error) {
        console.warn(
          `[desktop-appsnap] Removing unreadable pending capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await FS.promises.unlink(imagePath).catch(() => undefined);
        await FS.promises.unlink(metadataPath).catch(() => undefined);
      }
    }

    // The helper writes its PNG before Electron can durably create the
    // pending pair. Recover that original after a crash in the narrow gap.
    for (const entry of entries) {
      const captureId = HELPER_CAPTURE_IMAGE_PATTERN.exec(entry)?.[1];
      if (!captureId) continue;
      const helperImagePath = Path.join(this.#options.captureDirectory, entry);
      if (records.some((record) => record.capture.id === captureId)) {
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await readValidatedPendingPng(helperImagePath);
      } catch (error) {
        console.warn(
          `[desktop-appsnap] Removing unreadable helper capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
        continue;
      }

      const capturedAt = this.#options.now().toISOString();
      const capture: DesktopAppSnapCapture = {
        id: captureId,
        capturedAt,
        name: entry,
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        bytes: new Uint8Array(bytes),
        sourceAppName: null,
        sourceBundleIdentifier: null,
        sourceAppIconDataUrl: null,
        sourceWindowTitle: null,
      };
      try {
        records.push(await this.#persistPendingCapture(capture));
        await FS.promises.unlink(helperImagePath).catch(() => undefined);
      } catch (error) {
        // Keep the helper image as the recovery source for the next startup.
        console.warn(
          `[desktop-appsnap] Could not recover helper capture ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    records.sort(
      (left, right) =>
        Date.parse(left.capture.capturedAt) - Date.parse(right.capture.capturedAt) ||
        left.capture.id.localeCompare(right.capture.id),
    );
    const overflow = records.slice(0, Math.max(0, records.length - MAX_PENDING_CAPTURES));
    for (const record of overflow) {
      await this.#deletePendingCaptureFiles(record).catch((error) =>
        console.warn("[desktop-appsnap] Could not remove an overflow pending capture", error),
      );
    }
    this.#pendingCaptures = records.slice(-MAX_PENDING_CAPTURES);
  }

  async #persistPendingCapture(
    capture: DesktopAppSnapCapture,
  ): Promise<PendingAppSnapCaptureRecord> {
    const paths = pendingCaptureStoragePaths(this.#options.captureDirectory, capture.id);
    await writePrivateFileAtomically(paths.imagePath, capture.bytes);
    try {
      const metadata = Buffer.from(`${JSON.stringify(toStoredPendingCapture(capture))}\n`, "utf8");
      if (metadata.byteLength > MAX_PENDING_CAPTURE_METADATA_BYTES) {
        throw new Error("Pending AppSnap metadata exceeds its storage limit.");
      }
      await writePrivateFileAtomically(paths.metadataPath, metadata);
    } catch (error) {
      await FS.promises.unlink(paths.imagePath).catch(() => undefined);
      throw error;
    }
    return { capture, ...paths };
  }

  async #deletePendingCaptureFiles(record: PendingAppSnapCaptureRecord): Promise<void> {
    await FS.promises.unlink(record.imagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await FS.promises.unlink(record.metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async #recordPendingCapture(pendingRecord: PendingAppSnapCaptureRecord): Promise<void> {
    const nextPendingCaptures = [
      ...this.#pendingCaptures.filter((entry) => entry.capture.id !== pendingRecord.capture.id),
      pendingRecord,
    ];
    const discardedRecord =
      nextPendingCaptures.length > MAX_PENDING_CAPTURES ? nextPendingCaptures[0] : null;
    this.#pendingCaptures = nextPendingCaptures.slice(-MAX_PENDING_CAPTURES);
    if (discardedRecord) {
      await this.#deletePendingCaptureFiles(discardedRecord).catch((error) =>
        console.warn("[desktop-appsnap] Could not delete an overflow pending capture", error),
      );
      this.#emitCaptureError(
        "pending-capture-overflow",
        `Synara could retain only the latest ${MAX_PENDING_CAPTURES} AppSnaps while the composer was unavailable. The oldest capture was discarded.`,
        discardedRecord.capture.capturedAt,
        false,
      );
    }
  }

  #emitState(): void {
    const state = this.getState();
    const json = JSON.stringify(state);
    if (json === this.#lastEmittedStateJson) return;
    this.#lastEmittedStateJson = json;
    this.#options.onState(state);
  }

  #setState(status: DesktopAppSnapState["status"], message: string | null): void {
    const changed = this.#status !== status || this.#message !== message;
    this.#status = status;
    this.#message = message;
    if (changed) this.#emitState();
  }

  async #reconcileWatchProcess(): Promise<void> {
    this.#watchReconcileRequested = true;
    if (this.#watchReconcilePromise) {
      await this.#watchReconcilePromise;
      if (this.#watchReconcileRequested) {
        await this.#reconcileWatchProcess();
      }
      return;
    }
    const reconcilePromise = (async () => {
      while (this.#watchReconcileRequested) {
        this.#watchReconcileRequested = false;
        await this.#reconcileWatchProcessOnce();
      }
    })();
    let trackedPromise: Promise<void>;
    trackedPromise = reconcilePromise.finally(() => {
      if (this.#watchReconcilePromise === trackedPromise) {
        this.#watchReconcilePromise = null;
      }
    });
    this.#watchReconcilePromise = trackedPromise;
    await trackedPromise;
    if (this.#watchReconcileRequested) {
      await this.#reconcileWatchProcess();
    }
  }

  async #reconcileWatchProcessOnce(): Promise<void> {
    if (this.#disposed || this.#platform !== "macos") return;
    if (!this.#enabled) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("disabled", null);
      return;
    }
    if (
      this.#inputMonitoringPermission !== "granted" ||
      this.#screenRecordingPermission !== "granted"
    ) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState(
        "permission-required",
        permissionRequiredMessage({
          inputMonitoring: this.#inputMonitoringPermission,
          screenRecording: this.#screenRecordingPermission,
        }),
      );
      return;
    }
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return;
    }
    if (this.#shortcut.kind === "key-chord" && !this.#reserveShortcut(this.#shortcut)) {
      this.#stopWatchProcess();
      this.#setState("error", "The AppSnap shortcut is already used by macOS or another app.");
      return;
    }
    if (this.#shortcut.kind === "both-option-keys") this.#releaseShortcutReservation();
    if (this.#watchProcess) return;
    try {
      await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
      await FS.promises.chmod(this.#options.captureDirectory, 0o700).catch(() => undefined);
      if (
        this.#disposed ||
        !this.#enabled ||
        this.#watchProcess ||
        this.#inputMonitoringPermission !== "granted" ||
        this.#screenRecordingPermission !== "granted"
      ) {
        if (!this.#watchProcess) this.#releaseShortcutReservation();
        return;
      }
      this.#startWatchProcess();
    } catch (error) {
      this.#releaseShortcutReservation();
      this.#setState(
        "error",
        `Could not start AppSnap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #startWatchProcess(): void {
    this.#intentionalWatchStop = false;
    this.#setState("starting", null);
    // Key chords are detected by Electron's reserved accelerator; the helper
    // only captures on demand, driven by "trigger" lines on its stdin.
    const shortcutArguments = this.#shortcut.kind === "key-chord" ? ["--external-trigger"] : [];
    const child = this.#options.spawn(
      this.#options.helperPath,
      [
        "--watch",
        "--output-dir",
        this.#options.captureDirectory,
        "--excluded-bundle-id",
        this.#options.excludedBundleId,
        ...shortcutArguments,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // A helper that dies mid-write must not surface as an unhandled stream error.
    child.stdin?.on("error", () => undefined);
    this.#watchProcess = child;
    this.#watchOutputLines = this.#wireHelperOutput(child, (message) =>
      this.#handleWatchMessage(child, message),
    );
    child.once("error", (error) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      this.#watchOutputLines?.close();
      this.#watchOutputLines = null;
      this.#rejectPendingRequests("AppSnap stopped listening while a request was in flight.");
      this.#releaseShortcutReservation();
      const message = `Could not start AppSnap: ${error.message}`;
      this.#setState("error", message);
      this.#emitCaptureError("helper-stopped", message, undefined, false);
    });
    child.once("exit", (code, signal) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      this.#watchOutputLines?.close();
      this.#watchOutputLines = null;
      this.#rejectPendingRequests("AppSnap stopped listening while a request was in flight.");
      if (this.#disposed || this.#intentionalWatchStop || !this.#enabled) return;
      this.#releaseShortcutReservation();
      const message = `The AppSnap helper stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}).`;
      this.#setState("error", message);
      this.#emitCaptureError("helper-stopped", message, undefined, false);
    });
  }

  #stopWatchProcess(): void {
    const child = this.#watchProcess;
    this.#watchProcess = null;
    this.#watchOutputLines?.close();
    this.#watchOutputLines = null;
    this.#rejectPendingRequests("AppSnap stopped listening while a request was in flight.");
    if (!child) return;
    this.#intentionalWatchStop = true;
    child.kill("SIGTERM");
  }

  #reserveShortcut(shortcut: Extract<DesktopAppSnapShortcut, { kind: "key-chord" }>): boolean {
    const accelerator = appSnapShortcutAccelerator(shortcut);
    if (this.#registeredAccelerator === accelerator) return true;
    const registry = this.#options.shortcutRegistry;
    if (!registry) return false;
    try {
      if (!registry.register(accelerator, () => this.#handleShortcutTrigger())) return false;
      this.#registeredAccelerator = accelerator;
      return true;
    } catch {
      return false;
    }
  }

  #handleShortcutTrigger(): void {
    if (this.#disposed || !this.#enabled) return;
    try {
      this.#watchProcess?.stdin?.write("trigger\n");
    } catch {
      // The helper exit handler owns recovery; a lost trigger is acceptable.
    }
  }

  #releaseShortcutReservation(): void {
    const accelerator = this.#registeredAccelerator;
    this.#registeredAccelerator = null;
    if (!accelerator) return;
    try {
      this.#options.shortcutRegistry?.unregister(accelerator);
    } catch {
      // Electron may already have cleared global shortcuts during app shutdown.
    }
  }

  #wireHelperOutput(
    child: AppSnapHelperProcess,
    onMessage: (message: AppSnapHelperMessage) => void,
  ): Readline.Interface {
    const lines = Readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseAppSnapHelperMessage(line);
      if (message) onMessage(message);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length >= MAX_HELPER_STDERR_CHARS) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_HELPER_STDERR_CHARS);
    });
    child.once("close", (code) => {
      const diagnostic = stderr.trim();
      if (code !== 0 && diagnostic.length > 0) {
        console.warn(`[desktop-appsnap] Native helper: ${diagnostic}`);
      }
    });
    return lines;
  }

  async #runPermissionCommand(
    command: AppSnapPermissionCommand,
    permissions?: readonly DesktopAppSnapPermissionKind[],
    allowCached = false,
    setupGeneration?: number,
  ): Promise<boolean> {
    const kinds = permissions ?? APP_SNAP_LEGACY_PERMISSION_KINDS;
    const key = `${allowCached ? "cached" : "fresh"}:${[...new Set(kinds)].toSorted().join(",")}`;
    // The guide, settings, and server may ask simultaneously. Share an actual
    // in-flight probe, but never serve a cached grant to the guide's fresh poll.
    if (command === "--check-permissions") {
      const pending = this.#permissionChecks.get(key);
      if (pending) return pending;
    }
    const run = this.#permissionCommandQueue.then(() => {
      if (setupGeneration !== undefined && setupGeneration !== this.#guideSessionGeneration)
        return false;
      if (
        allowCached &&
        kinds.every((kind) => {
          const at = this.#permissionCheckCache.get(kind);
          return (
            at !== undefined &&
            Date.now() - at < 5_000 &&
            this.#panePermission(APP_SNAP_PERMISSION_KIND_GUIDE_PANES[kind]) === "granted"
          );
        })
      )
        return true;
      return this.#executePermissionCommand(command, permissions, setupGeneration);
    });
    this.#permissionCommandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    if (command === "--check-permissions") this.#permissionChecks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#permissionChecks.get(key) === run) this.#permissionChecks.delete(key);
    }
  }

  #applyPermissionReport(message: Extract<AppSnapHelperMessage, { type: "permissions" }>): void {
    for (const kind of APP_SNAP_PERMISSION_SETUP_ORDER) {
      if (message[kind] === "denied") this.#permissionCheckCache.delete(kind);
    }
    // Fields absent from the payload were not part of this request; leaving
    // them untouched keeps an accessibility-aware check from erasing the
    // AppSnap set and vice versa.
    if (message.accessibility !== undefined) {
      this.#accessibilityPermission = message.accessibility;
    }
    if (message.inputMonitoring !== undefined) {
      this.#inputMonitoringPermission = message.inputMonitoring;
    }
    if (message.screenRecording !== undefined) {
      this.#screenRecordingPermission = message.screenRecording;
    }
    this.#emitState();
  }

  #permissionCheckFailed(kinds: readonly DesktopAppSnapPermissionKind[], message: string): void {
    for (const kind of kinds) {
      this.#permissionCheckCache.delete(kind);
      if (kind === "accessibility") this.#accessibilityPermission = "unknown";
      else if (kind === "inputMonitoring") this.#inputMonitoringPermission = "unknown";
      else this.#screenRecordingPermission = "unknown";
    }
    if (kinds.includes("inputMonitoring") || kinds.includes("screenRecording")) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
    }
    this.#setState("error", message);
  }

  async #executePermissionCommand(
    command: AppSnapPermissionCommand,
    permissions?: readonly DesktopAppSnapPermissionKind[],
    setupGeneration?: number,
  ): Promise<boolean> {
    if (this.#disposed || this.#platform !== "macos") return false;
    const kinds = permissions ?? APP_SNAP_LEGACY_PERMISSION_KINDS;
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#permissionCheckFailed(
        kinds,
        "The AppSnap native helper is missing from this desktop build.",
      );
      return false;
    }
    // The helper's legacy default is the AppSnap pair, so a legacy request
    // sends no selectors and keeps working with helpers that predate the flag.
    const permissionArguments = isLegacyPermissionSet(kinds)
      ? []
      : [...new Set(kinds)].flatMap((kind) => ["--permission", kind]);

    return await new Promise<boolean>((resolve) => {
      let child: AppSnapHelperProcess;
      try {
        child = this.#options.spawn(
          this.#options.helperPath,
          [
            command,
            ...permissionArguments,
            ...(command === "--check-permissions"
              ? []
              : ["--app-path", this.#options.appBundlePath]),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        this.#permissionCheckFailed(
          kinds,
          `Could not inspect AppSnap permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
        resolve(false);
        return;
      }
      this.#permissionProcess = child;
      let settled = false;
      const current = () =>
        setupGeneration === undefined || setupGeneration === this.#guideSessionGeneration;
      let report: Extract<AppSnapHelperMessage, { type: "permissions" }> | undefined;
      let reportedError: Extract<AppSnapHelperMessage, { type: "error" }> | undefined;
      const finish = (ok: boolean, message?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        outputLines.close();
        if (this.#permissionProcess === child) this.#permissionProcess = null;
        if (this.#disposed || !current()) {
          resolve(false);
          return;
        }
        if (reportedError) this.#recordPermissionSetupFailure(reportedError);
        if (ok && report) {
          // Publish only a complete successful report. A partial result or late
          // stdout after timeout must never preserve an old green badge.
          const now = Date.now();
          for (const kind of kinds) {
            if (report[kind] === "granted") this.#permissionCheckCache.set(kind, now);
          }
          this.#applyPermissionReport(report);
        } else {
          this.#permissionCheckFailed(
            kinds,
            message ?? "The AppSnap helper did not report its permission state.",
          );
        }
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        finish(false, "Checking macOS permissions timed out. Try Set up again.");
        child.kill();
      }, PERMISSION_COMMAND_TIMEOUT_MS);
      const outputLines = this.#wireHelperOutput(child, (message) => {
        if (settled || !current()) return;
        if (message.type === "permissions") {
          report = { ...report, ...message };
        } else if (message.type === "error") {
          reportedError = message;
        }
      });
      child.once("error", (error) => {
        finish(false, `Could not inspect AppSnap permissions: ${error.message}`);
      });
      child.once("close", (code: number | null) => {
        const completedReport = report;
        const complete =
          completedReport !== undefined &&
          kinds.every((kind) => completedReport[kind] !== undefined);
        finish(
          code === 0 && complete && reportedError === undefined,
          reportedError?.message ??
            (complete ? "The AppSnap permission check did not finish successfully." : undefined),
        );
      });
    });
  }

  /**
   * Releases synthetic input the OS may still believe is held after a
   * computer-use driver died mid-gesture — a leaked button makes the user's
   * real clicks feel dead system-wide until reboot. The Cua host calls this
   * at retire-time precisely because no daemon may be left to ask; posting
   * button-ups and a flags-clear is a no-op when nothing is held.
   *
   * Runs on the permission queue so it cannot interleave with a permission
   * command's helper spawn, and resolves true only on the helper's
   * `released` payload — a silent helper exit means the leak may stand.
   */
  async releaseHeldInput(): Promise<boolean> {
    const run = this.#permissionCommandQueue.then(() => this.#executeReleaseHeldInput());
    this.#permissionCommandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  #executeReleaseHeldInput(): Promise<boolean> {
    if (this.#disposed || this.#platform !== "macos") return Promise.resolve(false);
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let child: AppSnapHelperProcess;
      try {
        child = this.#options.spawn(this.#options.helperPath, ["--release-held-input"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(false);
        return;
      }
      let released = false;
      const timeout = setTimeout(() => {
        child.kill();
        resolve(false);
      }, PERMISSION_COMMAND_TIMEOUT_MS);
      this.#wireHelperOutput(child, (message) => {
        if (message.type === "release-held-input" && message.released === true) {
          released = true;
        }
      });
      child.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.once("close", () => {
        clearTimeout(timeout);
        resolve(released);
      });
    });
  }

  #handleWatchMessage(child: AppSnapHelperProcess, message: AppSnapHelperMessage): void {
    if (this.#disposed || this.#watchProcess !== child) return;
    if (message.type === "ready") {
      // `ready` only proves the event tap installed, i.e. Input Monitoring.
      // Screen Recording state is owned by permission checks and capture errors.
      this.#inputMonitoringPermission = "granted";
      this.#setState("ready", null);
      return;
    }
    if (message.type === "permissions") {
      this.#applyPermissionReport(message);
      // A revocation must stop the helper and flip the picker off; a grant
      // must start it. Reconcile so the UI follows the live permission state.
      void this.#reconcileWatchProcess();
      return;
    }
    if (message.type === "triggered") {
      if (!this.#pendingCaptureRequests.has(message.id)) {
        console.info(`[desktop-appsnap] Option chord triggered (${message.id}).`);
      }
      return;
    }
    if (message.type === "windows") {
      this.#settleWindowRequest(message.requestId, message.windows);
      return;
    }
    if (message.type === "captured") {
      if (this.#pendingCaptureRequests.has(message.id)) {
        this.#captureReadQueue = this.#captureReadQueue
          .then(() => this.#consumeRequestCapture(message))
          .catch((error) => {
            this.#settleCaptureRequest(
              message.id,
              null,
              error instanceof Error ? error : new Error(String(error)),
            );
            void this.#dropLateRequestCapture(message);
          });
        return;
      }
      if (this.#timedOutCaptureRequestIds.has(message.id)) {
        // The request already failed with a timeout, so the caller was told.
        // Drop the late file instead of consuming it as a hotkey capture.
        this.#captureReadQueue = this.#captureReadQueue
          .then(() => this.#dropLateRequestCapture(message))
          .catch(() => undefined);
        return;
      }
      this.#captureReadQueue = this.#captureReadQueue
        .then(() => this.#consumeCapture(message))
        .catch((error) => {
          this.#emitCaptureError(
            "capture-read-failed",
            error instanceof Error ? error.message : "Could not read the captured AppSnap.",
            message.capturedAt,
            true,
          );
        });
      return;
    }

    if (message.type === "error" && message.requestId !== undefined) {
      this.#settleWindowRequest(
        message.requestId,
        null,
        new Error(`${message.message} (${message.code})`),
      );
      return;
    }
    if (
      message.type === "error" &&
      message.id !== undefined &&
      this.#timedOutCaptureRequestIds.has(message.id)
    ) {
      // The request already failed with a timeout; a late error must not
      // surface a second, spurious failure toast.
      return;
    }

    if (
      message.type === "error" &&
      message.id !== undefined &&
      this.#pendingCaptureRequests.has(message.id)
    ) {
      this.#settleCaptureRequest(
        message.id,
        null,
        new Error(`${message.message} (${message.code})`),
      );
      return;
    }

    if (message.type !== "error") return;

    if (message.code === "event_tap_disabled" || message.code === "event-tap-disabled") {
      console.warn(`[desktop-appsnap] ${message.message}`);
      return;
    }

    console.warn(`[desktop-appsnap] Helper error ${message.code}: ${message.message}`);

    if (message.code === "input-monitoring-required") {
      this.#inputMonitoringPermission = "denied";
    }
    if (message.code === "screen-recording-required") {
      this.#screenRecordingPermission = "denied";
    }
    if (isPermissionErrorCode(message.code)) {
      this.#stopWatchProcess();
      this.#releaseShortcutReservation();
      this.#setState(
        "permission-required",
        permissionRequiredMessage({
          inputMonitoring: this.#inputMonitoringPermission,
          screenRecording: this.#screenRecordingPermission,
        }),
      );
    }
    // Benign overlap errors surface as a toast without yanking Synara to the
    // foreground while the user is still working in the captured app.
    this.#emitCaptureError(
      message.code,
      message.message,
      message.capturedAt,
      !isBenignCaptureErrorCode(message.code),
    );
  }

  async #readCaptureFromHelperMessage(
    message: Extract<AppSnapHelperMessage, { type: "captured" }>,
  ): Promise<{ capture: DesktopAppSnapCapture; capturePath: string }> {
    const capturePath = Path.resolve(message.path);
    if (!isPathInsideDirectory(this.#options.captureDirectory, capturePath)) {
      throw new Error("The AppSnap helper returned a capture outside its private directory.");
    }

    const bytes = await readValidatedPendingPng(capturePath);
    const now = this.#options.now();
    const capture: DesktopAppSnapCapture = {
      id: normalizeOptionalText(message.id, 128) ?? Crypto.randomUUID(),
      capturedAt: normalizeDate(message.capturedAt, now),
      name:
        normalizeOptionalText(message.name, 240) ??
        `AppSnap-${now.toISOString().replace(/[:.]/g, "-")}.png`,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      bytes: new Uint8Array(bytes),
      sourceAppName: normalizeOptionalText(message.sourceAppName),
      sourceBundleIdentifier: normalizeOptionalText(message.sourceBundleIdentifier),
      sourceAppIconDataUrl: normalizeAppIconDataUrl(message.sourceAppIconDataUrl),
      sourceWindowTitle: normalizeOptionalText(message.sourceWindowTitle),
    };
    return { capture, capturePath };
  }

  async #consumeCapture(
    message: Extract<AppSnapHelperMessage, { type: "captured" }>,
  ): Promise<void> {
    const { capture, capturePath } = await this.#readCaptureFromHelperMessage(message);
    await this.#ensurePendingCapturesLoaded();
    const pendingRecord = await this.#persistPendingCapture(capture);
    // Only delete the helper's temporary file once the pending copy durably
    // owns the capture; deleting it earlier would destroy the only on-disk
    // copy when persistence fails transiently.
    await FS.promises.unlink(capturePath).catch(() => undefined);
    await this.#recordPendingCapture(pendingRecord);
    this.#options.onCaptured(capture);
  }

  async #consumeRequestCapture(
    message: Extract<AppSnapHelperMessage, { type: "captured" }>,
  ): Promise<void> {
    const { capture, capturePath } = await this.#readCaptureFromHelperMessage(message);
    await this.#ensurePendingCapturesLoaded();
    if (!this.#pendingCaptureRequests.has(capture.id)) {
      await FS.promises.unlink(capturePath).catch(() => undefined);
      return;
    }
    const pendingRecord = await this.#persistPendingCapture(capture);
    if (!this.#pendingCaptureRequests.has(capture.id)) {
      await Promise.all([
        FS.promises.unlink(capturePath).catch(() => undefined),
        this.#deletePendingCaptureFiles(pendingRecord).catch(() => undefined),
      ]);
      return;
    }

    // Register the durable recovery copy before resolving the renderer promise,
    // and remove the helper's temporary file first so a settled request has the
    // pending copy as the only remaining owner. A timeout that interleaves
    // during the unlink still cleans the pending copy through `settled`.
    const recordPromise = this.#recordPendingCapture(pendingRecord);
    await FS.promises.unlink(capturePath).catch(() => undefined);
    const settled = this.#settleCaptureRequest(capture.id, capture);
    await recordPromise;
    if (!settled) {
      this.#pendingCaptures = this.#pendingCaptures.filter(
        ({ capture: pendingCapture }) => pendingCapture.id !== capture.id,
      );
      await this.#deletePendingCaptureFiles(pendingRecord).catch(() => undefined);
    }
  }

  #emitCaptureError(
    code: string,
    message: string,
    capturedAt: string | undefined,
    focusApp: boolean,
  ): void {
    this.#options.onError(
      {
        code: normalizeOptionalText(code, 128) ?? "capture-failed",
        message: normalizeOptionalText(message, 1_000) ?? "AppSnap capture failed.",
        capturedAt: normalizeDate(capturedAt, this.#options.now()),
      },
      focusApp,
    );
  }
}
