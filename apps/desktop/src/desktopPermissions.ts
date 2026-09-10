import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import type { Readable } from "node:stream";

import type { DesktopPermission } from "@synara/contracts";
export type { DesktopPermission } from "@synara/contracts";
export type DesktopPermissionStatus = "granted" | "denied";
export type DesktopPermissionState<Permission extends DesktopPermission> = Record<
  Permission,
  DesktopPermissionStatus
>;

export const APP_SNAP_PERMISSIONS = ["inputMonitoring", "screenRecording"] as const;

export function desktopPermissionSettingsUrl(permission: DesktopPermission): string {
  const pane = {
    accessibility: "Privacy_Accessibility",
    screenRecording: "Privacy_ScreenCapture",
    inputMonitoring: "Privacy_ListenEvent",
  }[permission];
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}

interface DesktopPermissionServiceOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  spawn?: typeof ChildProcess.spawn;
  openSettings?: (permission: DesktopPermission) => Promise<void>;
  timeoutMs?: number;
  operationTimeoutMs?: number;
}

type PermissionProcess = ChildProcess.ChildProcessByStdio<null, Readable, Readable>;
type PermissionCommand = "--check-permissions" | "--request-permissions";
const MAX_OUTPUT_BYTES = 16_384;
const MAX_DIAGNOSTIC_BYTES = 4_096;

/** Runs permission-only helpers directly under the signed desktop parent. */
export class DesktopPermissionService {
  readonly #options: DesktopPermissionServiceOptions;
  #queue: Promise<void> = Promise.resolve();
  #inFlight = new Map<string, Promise<Partial<DesktopPermissionState<DesktopPermission>>>>();
  #active: { child: PermissionProcess; cancel: () => void } | undefined;
  #disposed = false;

  constructor(options: DesktopPermissionServiceOptions) {
    this.#options = options;
  }

  check<Permission extends DesktopPermission>(
    permissions: readonly Permission[],
  ): Promise<DesktopPermissionState<Permission>> {
    return this.#enqueue("--check-permissions", permissions);
  }

  request<Permission extends DesktopPermission>(
    permissions: readonly Permission[],
    signal?: AbortSignal,
  ): Promise<DesktopPermissionState<Permission>> {
    return this.#enqueue("--request-permissions", permissions, signal);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const active = this.#active;
    active?.cancel();
    await this.#queue;
    if (this.#active === active && active) {
      throw new Error("The desktop permission helper has not stopped.");
    }
  }

  #enqueue<Permission extends DesktopPermission>(
    command: PermissionCommand,
    permissions: readonly Permission[],
    signal?: AbortSignal,
  ): Promise<DesktopPermissionState<Permission>> {
    const selected = [...new Set(permissions)].sort();
    if (selected.length === 0) {
      return Promise.reject(new Error("Choose at least one desktop permission."));
    }
    const key = `${command}:${selected.join(",")}`;
    // A cancellable setup owns its prompt. Do not coalesce its lifetime with another caller.
    const existing = signal ? undefined : this.#inFlight.get(key);
    if (existing) return existing as Promise<DesktopPermissionState<Permission>>;
    const abort = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout>;
    let cancel: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        const error = new Error("Desktop permission setup was cancelled.");
        abort.abort(error);
        reject(error);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      deadlineTimer = setTimeout(
        () => {
          const error = new Error("The desktop permission operation timed out. Try again.");
          abort.abort(error);
          reject(error);
        },
        this.#options.operationTimeoutMs ?? (command === "--request-permissions" ? 90_000 : 30_000),
      );
    });
    const run = this.#queue.then(async () => {
      let state = await this.#runHelper(command, selected, abort.signal);
      if (command === "--request-permissions") {
        // macOS may cache preflight results in the process that requested access.
        state = await this.#runHelper("--check-permissions", selected, abort.signal);
        abort.signal.throwIfAborted();
        if (this.#disposed) throw new Error("Desktop permissions are shutting down.");
        const missing = permissions.find((permission) => state[permission] !== "granted");
        // No native child remains here; a stuck Settings launch must not retain the lane.
        if (missing) await Promise.race([this.#options.openSettings?.(missing), deadline]);
      }
      return state;
    });
    const tracked = Promise.race([run, deadline]).finally(() => {
      clearTimeout(deadlineTimer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      if (this.#inFlight.get(key) === tracked) this.#inFlight.delete(key);
    });
    if (!signal) this.#inFlight.set(key, tracked);
    // A deadline settles the caller immediately, but the lane remains owned until cleanup finishes.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  #runHelper<Permission extends DesktopPermission>(
    command: PermissionCommand,
    selected: readonly Permission[],
    signal: AbortSignal,
  ): Promise<DesktopPermissionState<Permission>> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#disposed) return Promise.reject(new Error("Desktop permissions are shutting down."));
    if (this.#options.platform !== "darwin") {
      return Promise.reject(new Error("Desktop permissions are available only on macOS."));
    }
    if (this.#active) {
      return Promise.reject(new Error("The previous desktop permission helper has not stopped."));
    }
    if (!FS.existsSync(this.#options.helperPath)) {
      return Promise.reject(
        new Error("The AppSnap native helper is missing from this desktop build."),
      );
    }

    const legacyScopes =
      selected.length === APP_SNAP_PERMISSIONS.length &&
      APP_SNAP_PERMISSIONS.every((permission) => selected.includes(permission as Permission));
    const arguments_ = [
      command,
      ...(legacyScopes ? [] : selected.flatMap((permission) => ["--permission", permission])),
    ];
    let child: PermissionProcess;
    try {
      child = (this.#options.spawn ?? ChildProcess.spawn)(this.#options.helperPath, arguments_, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let diagnostic = "";
      let failure: Error | undefined;
      let terminationRequested = false;
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number | null) => {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        clearTimeout(reapTimer);
        if (settled) return;
        settled = true;
        if (failure) return reject(failure);
        if (code !== 0) {
          return reject(new Error(diagnostic.trim() || "The desktop permission helper failed."));
        }
        for (const line of output.split("\n")) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (!value || typeof value !== "object") continue;
          const message = value as Record<string, unknown>;
          if (message.type === "error" && typeof message.message === "string") {
            return reject(new Error(message.message));
          }
          if (message.type !== "permissions") continue;
          if (
            selected.every(
              (permission) => message[permission] === "granted" || message[permission] === "denied",
            )
          ) {
            return resolve(
              Object.fromEntries(
                selected.map((permission) => [permission, message[permission]]),
              ) as DesktopPermissionState<Permission>,
            );
          }
        }
        reject(
          new Error("The desktop permission helper did not report the requested permission state."),
        );
      };
      const terminate = (error: Error) => {
        if (terminationRequested || settled) return;
        terminationRequested = true;
        failure ??= error;
        // Keep ownership until close; a timed-out command must never overlap its successor.
        forceTimer = setTimeout(() => {
          reapTimer = setTimeout(() => finish(null), 1_000);
          child.kill("SIGKILL");
        }, 1_000);
        child.kill("SIGTERM");
      };
      const timeout = setTimeout(
        () =>
          terminate(
            new Error(
              "The desktop permission helper timed out. Try again after closing the macOS prompt.",
            ),
          ),
        this.#options.timeoutMs ?? (command === "--request-permissions" ? 60_000 : 10_000),
      );
      this.#active = {
        child,
        cancel: () => terminate(new Error("The desktop permission check was cancelled.")),
      };
      const onAbort = () =>
        terminate(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The desktop permission operation was cancelled."),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (data: Buffer) => {
        outputBytes += data.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          terminate(new Error("The desktop permission helper returned too much output."));
        } else {
          output += data.toString("utf8");
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        diagnostic = (diagnostic + data.subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")).slice(
          -MAX_DIAGNOSTIC_BYTES,
        );
      });
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        if (this.#active?.child === child) this.#active = undefined;
        finish(code);
      });
    });
  }
}
