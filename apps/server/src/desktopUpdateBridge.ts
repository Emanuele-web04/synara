// Purpose: Correlates updater requests over the backend's private parent IPC channel.
// Layer: Server desktop bridge; the capability marker is consumed before provider launches.
import { randomUUID } from "node:crypto";

import {
  DesktopUpdateIpcResponse,
  type DesktopUpdateIpcRequest,
  type ServerDesktopUpdateResult,
} from "@synara/contracts";
import { Schema } from "effect";

const DESKTOP_UPDATE_IPC_ENV = "SYNARA_DESKTOP_UPDATE_IPC";
const pending = new Map<
  string,
  {
    readonly resolve: (value: ServerDesktopUpdateResult) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }
>();
let initialized = false;

export function desktopUpdateBridgeAvailable(): boolean {
  return initialized && process.connected === true && typeof process.send === "function";
}

// No credential or listener is added to the network; Node's owned-child IPC is the authority.
export function initializeDesktopUpdateBridge(): void {
  const keys = Object.keys(process.env).filter((key) =>
    process.platform === "win32"
      ? key.toUpperCase() === DESKTOP_UPDATE_IPC_ENV
      : key === DESKTOP_UPDATE_IPC_ENV,
  );
  const enabled = keys.some((key) => process.env[key] === "1");
  keys.forEach((key) => {
    delete process.env[key];
  });
  if (initialized || !enabled || !process.connected || typeof process.send !== "function") return;
  initialized = true;
  process.on("message", (raw: unknown) => {
    if (!Schema.is(DesktopUpdateIpcResponse)(raw)) return;
    const entry = pending.get(raw.id);
    if (!entry) return;
    pending.delete(raw.id);
    clearTimeout(entry.timeout);
    entry.resolve(raw.result);
  });
  process.once("disconnect", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Desktop updater connection closed."));
    }
    pending.clear();
  });
}

export function requestDesktopUpdate(
  request: Omit<DesktopUpdateIpcRequest, "type" | "id">,
): Promise<ServerDesktopUpdateResult> {
  if (!desktopUpdateBridgeAvailable())
    return Promise.reject(new Error("Desktop updates are unavailable."));
  if (pending.size >= 8) return Promise.reject(new Error("Desktop updater is busy. Try again."));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const fail = (error: Error) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timeout);
      reject(error);
    };
    const timeout = setTimeout(() => fail(new Error("Desktop updater did not respond.")), 10_000);
    timeout.unref();
    pending.set(id, { resolve, reject, timeout });
    try {
      process.send!({ type: "synara:desktop-update:request", id, ...request }, (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Desktop updater connection failed."));
    }
  });
}
