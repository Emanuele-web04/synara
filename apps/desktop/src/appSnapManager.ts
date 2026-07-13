// FILE: appSnapManager.ts
// Purpose: Owns the macOS AppSnap helper lifecycle, permission state, and pending captures.
// Layer: Desktop main-process service
// Depends on: A signed Swift helper plus narrow filesystem/process adapters.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DesktopAppSnapCapture,
  type DesktopAppSnapErrorEvent,
  type DesktopAppSnapPermission,
  type DesktopAppSnapPlatform,
  type DesktopAppSnapState,
} from "@synara/contracts";

const MAX_PENDING_CAPTURES = PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
const MAX_HELPER_STDERR_CHARS = 4_096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type AppSnapHelperMessage =
  | {
      type: "permissions";
      inputMonitoring: "granted" | "denied";
      screenRecording: "granted" | "denied";
    }
  | { type: "ready" }
  | { type: "triggered"; id: string; capturedAt?: string }
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
  | {
      type: "error";
      id?: string;
      code: string;
      message: string;
      capturedAt?: string;
    };

export interface DesktopAppSnapManagerOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  captureDirectory: string;
  excludedBundleId: string;
  onState: (state: DesktopAppSnapState) => void;
  onCaptured: (capture: DesktopAppSnapCapture) => void;
  onError: (error: DesktopAppSnapErrorEvent, focusApp: boolean) => void;
  now?: () => Date;
  spawn?: typeof ChildProcess.spawn;
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

  if (
    value.type === "permissions" &&
    isPermission(value.inputMonitoring) &&
    isPermission(value.screenRecording)
  ) {
    return {
      type: "permissions",
      inputMonitoring: value.inputMonitoring,
      screenRecording: value.screenRecording,
    };
  }
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "triggered" && typeof value.id === "string" && value.id.length > 0) {
    return {
      type: "triggered",
      id: value.id,
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
      ...(typeof value.sourceBundleIdentifier === "string" ||
      value.sourceBundleIdentifier === null
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
    };
  }
  return null;
}

export function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = Path.relative(Path.resolve(directory), Path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${Path.sep}`) && relative !== "..";
}

function permissionRequiredMessage(
  inputMonitoring: DesktopAppSnapPermission,
  screenRecording: DesktopAppSnapPermission,
): string {
  const missing: string[] = [];
  if (inputMonitoring !== "granted") missing.push("Input Monitoring");
  if (screenRecording !== "granted") missing.push("Screen Recording");
  return `Allow ${missing.join(" and ")} in macOS System Settings, then try again.`;
}

function isPermissionErrorCode(code: string): boolean {
  return (
    code === "input-monitoring-required" ||
    code === "screen-recording-required" ||
    code === "permission-required"
  );
}

export class DesktopAppSnapManager {
  readonly #options: Required<
    Pick<DesktopAppSnapManagerOptions, "now" | "spawn">
  > &
    Omit<DesktopAppSnapManagerOptions, "now" | "spawn">;
  readonly #platform: DesktopAppSnapPlatform;
  #enabled = false;
  #inputMonitoringPermission: DesktopAppSnapPermission = "unknown";
  #screenRecordingPermission: DesktopAppSnapPermission = "unknown";
  #status: DesktopAppSnapState["status"];
  #message: string | null;
  #watchProcess: ChildProcess.ChildProcessWithoutNullStreams | null = null;
  #permissionProcess: ChildProcess.ChildProcessWithoutNullStreams | null = null;
  #permissionCommandQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  #intentionalWatchStop = false;
  #pendingCaptures: DesktopAppSnapCapture[] = [];
  #captureReadQueue: Promise<void> = Promise.resolve();

  constructor(options: DesktopAppSnapManagerOptions) {
    this.#options = {
      ...options,
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
      status: this.#status,
      shortcut: this.#platform === "macos" ? "both-option-keys" : null,
      inputMonitoringPermission: this.#inputMonitoringPermission,
      screenRecordingPermission: this.#screenRecordingPermission,
      message: this.#message,
    };
  }

  async refreshState(): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (!(await this.#runPermissionCommand("--check-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async setEnabled(enabled: boolean): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    this.#enabled = enabled;
    if (!enabled) {
      this.#stopWatchProcess();
      this.#setState("disabled", null);
      return this.getState();
    }
    if (!(await this.#runPermissionCommand("--check-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  async requestPermissions(): Promise<DesktopAppSnapState> {
    if (this.#platform !== "macos" || this.#disposed) return this.getState();
    if (!(await this.#runPermissionCommand("--request-permissions"))) return this.getState();
    await this.#reconcileWatchProcess();
    return this.getState();
  }

  listPendingCaptures(): DesktopAppSnapCapture[] {
    return this.#pendingCaptures.map((capture) => ({
      ...capture,
      bytes: new Uint8Array(capture.bytes),
    }));
  }

  acknowledgeCapture(captureId: string): void {
    if (captureId.trim().length === 0) return;
    this.#pendingCaptures = this.#pendingCaptures.filter((capture) => capture.id !== captureId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopWatchProcess();
    this.#permissionProcess?.kill("SIGTERM");
    this.#permissionProcess = null;
    this.#pendingCaptures = [];
  }

  #emitState(): void {
    this.#options.onState(this.getState());
  }

  #setState(status: DesktopAppSnapState["status"], message: string | null): void {
    const changed = this.#status !== status || this.#message !== message;
    this.#status = status;
    this.#message = message;
    if (changed) this.#emitState();
  }

  async #reconcileWatchProcess(): Promise<void> {
    if (this.#disposed || this.#platform !== "macos") return;
    if (!this.#enabled) {
      this.#stopWatchProcess();
      this.#setState("disabled", null);
      return;
    }
    if (
      this.#inputMonitoringPermission !== "granted" ||
      this.#screenRecordingPermission !== "granted"
    ) {
      this.#stopWatchProcess();
      this.#setState(
        "permission-required",
        permissionRequiredMessage(
          this.#inputMonitoringPermission,
          this.#screenRecordingPermission,
        ),
      );
      return;
    }
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#stopWatchProcess();
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return;
    }
    if (this.#watchProcess) return;
    try {
      await FS.promises.mkdir(this.#options.captureDirectory, { recursive: true, mode: 0o700 });
      await FS.promises.chmod(this.#options.captureDirectory, 0o700).catch(() => undefined);
      this.#startWatchProcess();
    } catch (error) {
      this.#setState(
        "error",
        `Could not start AppSnap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #startWatchProcess(): void {
    this.#intentionalWatchStop = false;
    this.#setState("starting", null);
    const child = this.#options.spawn(
      this.#options.helperPath,
      [
        "--watch",
        "--output-dir",
        this.#options.captureDirectory,
        "--excluded-bundle-id",
        this.#options.excludedBundleId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#watchProcess = child;
    this.#wireHelperOutput(child, (message) => this.#handleWatchMessage(message));
    child.once("error", (error) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      this.#setState("error", `Could not start AppSnap: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.#watchProcess !== child) return;
      this.#watchProcess = null;
      if (this.#disposed || this.#intentionalWatchStop || !this.#enabled) return;
      this.#setState(
        "error",
        `The AppSnap helper stopped unexpectedly (${signal ?? `exit ${code ?? "unknown"}`}).`,
      );
    });
  }

  #stopWatchProcess(): void {
    const child = this.#watchProcess;
    this.#watchProcess = null;
    if (!child) return;
    this.#intentionalWatchStop = true;
    child.kill("SIGTERM");
  }

  #wireHelperOutput(
    child: ChildProcess.ChildProcessWithoutNullStreams,
    onMessage: (message: AppSnapHelperMessage) => void,
  ): void {
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
  }

  async #runPermissionCommand(
    command: "--check-permissions" | "--request-permissions",
  ): Promise<boolean> {
    const run = this.#permissionCommandQueue.then(() => this.#executePermissionCommand(command));
    this.#permissionCommandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async #executePermissionCommand(
    command: "--check-permissions" | "--request-permissions",
  ): Promise<boolean> {
    if (this.#disposed || this.#platform !== "macos") return false;
    if (!FS.existsSync(this.#options.helperPath)) {
      this.#setState("error", "The AppSnap native helper is missing from this desktop build.");
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let child: ChildProcess.ChildProcessWithoutNullStreams;
      try {
        child = this.#options.spawn(this.#options.helperPath, [command], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        this.#setState(
          "error",
          `Could not inspect AppSnap permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
        resolve(false);
        return;
      }
      this.#permissionProcess = child;
      let receivedPermissions = false;
      let reportedError: string | null = null;
      let spawnFailed = false;
      this.#wireHelperOutput(child, (message) => {
        if (message.type === "permissions") {
          receivedPermissions = true;
          this.#inputMonitoringPermission = message.inputMonitoring;
          this.#screenRecordingPermission = message.screenRecording;
          this.#emitState();
        } else if (message.type === "error") {
          reportedError = message.message;
        }
      });
      child.once("error", (error) => {
        spawnFailed = true;
        if (this.#permissionProcess === child) this.#permissionProcess = null;
        this.#setState("error", `Could not inspect AppSnap permissions: ${error.message}`);
        resolve(false);
      });
      child.once("close", () => {
        if (this.#permissionProcess === child) this.#permissionProcess = null;
        if (this.#disposed) {
          resolve(false);
          return;
        }
        if (!receivedPermissions && !spawnFailed) {
          this.#setState(
            "error",
            reportedError ?? "The AppSnap helper did not report its permission state.",
          );
        }
        resolve(receivedPermissions);
      });
    });
  }

  #handleWatchMessage(message: AppSnapHelperMessage): void {
    if (message.type === "ready") {
      this.#inputMonitoringPermission = "granted";
      this.#screenRecordingPermission = "granted";
      this.#setState("ready", null);
      return;
    }
    if (message.type === "permissions") {
      this.#inputMonitoringPermission = message.inputMonitoring;
      this.#screenRecordingPermission = message.screenRecording;
      this.#emitState();
      return;
    }
    if (message.type === "triggered") {
      console.info(`[desktop-appsnap] Option chord triggered (${message.id}).`);
      return;
    }
    if (message.type === "captured") {
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
      this.#setState(
        "permission-required",
        permissionRequiredMessage(
          this.#inputMonitoringPermission,
          this.#screenRecordingPermission,
        ),
      );
    }
    this.#emitCaptureError(message.code, message.message, message.capturedAt, true);
  }

  async #consumeCapture(message: Extract<AppSnapHelperMessage, { type: "captured" }>): Promise<void> {
    const capturePath = Path.resolve(message.path);
    if (!isPathInsideDirectory(this.#options.captureDirectory, capturePath)) {
      throw new Error("The AppSnap helper returned a capture outside its private directory.");
    }

    try {
      const stats = await FS.promises.lstat(capturePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("The AppSnap helper did not return a regular image file.");
      }
      if (stats.size <= 0) throw new Error("The captured AppSnap is empty.");
      if (stats.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        throw new Error("The captured AppSnap exceeds the 10MB image attachment limit.");
      }
      const bytes = await FS.promises.readFile(capturePath);
      if (bytes.length !== stats.size || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error("The AppSnap helper returned an invalid PNG image.");
      }
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
      const nextPendingCaptures = [
        ...this.#pendingCaptures.filter((entry) => entry.id !== capture.id),
        capture,
      ];
      const discardedCapture =
        nextPendingCaptures.length > MAX_PENDING_CAPTURES ? nextPendingCaptures[0] : null;
      this.#pendingCaptures = nextPendingCaptures.slice(-MAX_PENDING_CAPTURES);
      if (discardedCapture) {
        this.#emitCaptureError(
          "pending-capture-overflow",
          `Synara could retain only the latest ${MAX_PENDING_CAPTURES} AppSnaps while the composer was unavailable. The oldest capture was discarded.`,
          discardedCapture.capturedAt,
          false,
        );
      }
      this.#options.onCaptured(capture);
    } finally {
      await FS.promises.unlink(capturePath).catch(() => undefined);
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
