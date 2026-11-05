// FILE: keepAwake.ts
// Purpose: "Keep this computer awake" for remote access — the persisted
//          preference plus the controller that holds an Electron sleep blocker
//          only while the preference is on, remote access is allowed, and the
//          computer runs on AC power.
// Layer: Desktop main process
// Depends on: filesystem for the preference file; the power monitor and sleep
//             blocker are injected so the controller is testable without Electron.

import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopKeepAwakeState } from "@synara/contracts";

export interface PersistedKeepAwakePreference {
  readonly version: 1;
  readonly enabled: boolean;
  /** Last "Allow connections" value the renderer reported, so launch needs no renderer. */
  readonly remoteAccessAllowed: boolean;
}

const DEFAULT_PREFERENCE: PersistedKeepAwakePreference = {
  version: 1,
  enabled: false,
  remoteAccessAllowed: false,
};

export function parseKeepAwakePreference(value: unknown): PersistedKeepAwakePreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.remoteAccessAllowed !== "boolean"
  )
    return null;
  return {
    version: 1,
    enabled: candidate.enabled,
    remoteAccessAllowed: candidate.remoteAccessAllowed,
  };
}

export function readKeepAwakePreference(filePath: string): PersistedKeepAwakePreference {
  try {
    return (
      parseKeepAwakePreference(JSON.parse(FS.readFileSync(filePath, "utf8"))) ?? DEFAULT_PREFERENCE
    );
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function writeKeepAwakePreference(
  filePath: string,
  preference: PersistedKeepAwakePreference,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(preference, null, 2)}\n`, "utf8");
}

/** The slice of Electron's `powerMonitor` the controller needs. */
export interface KeepAwakePowerMonitor {
  on(event: "on-ac" | "on-battery", listener: () => void): unknown;
  removeListener(event: "on-ac" | "on-battery", listener: () => void): unknown;
  isOnBatteryPower(): boolean;
}

/** The slice of Electron's `powerSaveBlocker` the controller needs. */
export interface KeepAwakeSleepBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export interface KeepAwakeController {
  getState(): DesktopKeepAwakeState;
  setEnabled(enabled: boolean): DesktopKeepAwakeState;
  setRemoteAccessAllowed(allowed: boolean): DesktopKeepAwakeState;
  dispose(): void;
}

export function createKeepAwakeController(input: {
  readonly monitor: KeepAwakePowerMonitor;
  readonly blocker: KeepAwakeSleepBlocker;
  readonly load: () => PersistedKeepAwakePreference;
  readonly save: (preference: PersistedKeepAwakePreference) => void;
  readonly onError?: (error: unknown) => void;
}): KeepAwakeController {
  let preference = input.load();
  let blockerId: number | null = null;

  const onBattery = () => {
    try {
      return input.monitor.isOnBatteryPower();
    } catch {
      // A platform that cannot report power never claims to be on battery.
      return false;
    }
  };

  const reconcile = () => {
    const wanted = preference.enabled && preference.remoteAccessAllowed && !onBattery();
    if (wanted && blockerId === null) {
      blockerId = input.blocker.start("prevent-app-suspension");
    } else if (!wanted && blockerId !== null) {
      input.blocker.stop(blockerId);
      blockerId = null;
    }
  };

  const state = (): DesktopKeepAwakeState => ({
    enabled: preference.enabled,
    active: blockerId !== null,
    onBattery: onBattery(),
  });

  const update = (next: Partial<Omit<PersistedKeepAwakePreference, "version">>) => {
    const merged = { ...preference, ...next };
    if (
      merged.enabled !== preference.enabled ||
      merged.remoteAccessAllowed !== preference.remoteAccessAllowed
    ) {
      preference = merged;
      try {
        input.save(preference);
      } catch (error) {
        // The live blocker still follows the new value; only persistence failed.
        input.onError?.(error);
      }
    }
    reconcile();
    return state();
  };

  input.monitor.on("on-ac", reconcile);
  input.monitor.on("on-battery", reconcile);
  reconcile();

  return {
    getState: state,
    setEnabled: (enabled) => update({ enabled }),
    setRemoteAccessAllowed: (remoteAccessAllowed) => update({ remoteAccessAllowed }),
    dispose: () => {
      input.monitor.removeListener("on-ac", reconcile);
      input.monitor.removeListener("on-battery", reconcile);
      if (blockerId !== null) input.blocker.stop(blockerId);
      blockerId = null;
    },
  };
}
