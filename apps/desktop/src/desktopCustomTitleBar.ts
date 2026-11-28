// FILE: desktopCustomTitleBar.ts
// Purpose: Persist the Windows/Linux custom title bar and rounded window corner
//          preferences for Electron boot.
// Layer: Desktop main process
// Depends on: filesystem; preference must be readable before BrowserWindow creation.

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  defaultCustomTitleBarPreference,
  resolveCustomTitleBarActive,
  supportsCustomTitleBar,
} from "@synara/shared/desktopTitleBar";

export interface PersistedCustomTitleBarPreference {
  readonly version: 1;
  readonly enabled: boolean;
  /** Absent in files written before the rounded corners toggle existed. */
  readonly roundedCorners?: boolean;
}

export interface CustomTitleBarPreference {
  readonly enabled: boolean;
  readonly roundedCorners: boolean;
}

export function parseCustomTitleBarPreference(
  value: unknown,
): PersistedCustomTitleBarPreference | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") {
    return null;
  }
  return typeof candidate.roundedCorners === "boolean"
    ? { version: 1, enabled: candidate.enabled, roundedCorners: candidate.roundedCorners }
    : { version: 1, enabled: candidate.enabled };
}

function readPersistedPreference(filePath: string): PersistedCustomTitleBarPreference | null {
  try {
    return parseCustomTitleBarPreference(JSON.parse(FS.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Both preferences from one read, so they always come from the same file version.
 * Frameless windows keep Electron's rounded corners unless the user turned them off.
 */
export function readCustomTitleBarSettings(filePath: string): {
  readonly enabled: boolean | null;
  readonly roundedCorners: boolean;
} {
  const persisted = readPersistedPreference(filePath);
  return { enabled: persisted?.enabled ?? null, roundedCorners: persisted?.roundedCorners ?? true };
}

export function writeCustomTitleBarPreference(
  filePath: string,
  preference: CustomTitleBarPreference,
): void {
  const payload: PersistedCustomTitleBarPreference = {
    version: 1,
    enabled: preference.enabled,
    roundedCorners: preference.roundedCorners,
  };
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function resolveDesktopCustomTitleBarState(input: {
  readonly platform: string;
  readonly preference: boolean | null;
  readonly active: boolean;
  readonly roundedCornersPreference: boolean;
  readonly roundedCornersActive: boolean;
}): {
  readonly supported: boolean;
  readonly preference: boolean;
  readonly active: boolean;
  readonly roundedCornersPreference: boolean;
  readonly roundedCornersActive: boolean;
  readonly restartRequired: boolean;
} {
  const supported = supportsCustomTitleBar(input.platform);
  const preference = supported
    ? (input.preference ?? defaultCustomTitleBarPreference(input.platform))
    : false;
  const active = supported ? input.active : false;
  // Corner rounding only exists on frameless windows, so it only forces a restart
  // when the window stays frameless across the relaunch.
  const cornersPending =
    preference && active && input.roundedCornersPreference !== input.roundedCornersActive;
  return {
    supported,
    preference,
    active,
    roundedCornersPreference: input.roundedCornersPreference,
    roundedCornersActive: input.roundedCornersActive,
    restartRequired: supported && (preference !== active || cornersPending),
  };
}

export function resolveDesktopTitleBarFrameOptions(input: {
  readonly platform: NodeJS.Platform;
  readonly preference: boolean | null;
  readonly roundedCorners: boolean;
}): { frame: false; roundedCorners?: false } | Record<string, never> {
  const active = resolveCustomTitleBarActive({
    platform: input.platform,
    preference: input.preference,
  });
  if (!active) return {};
  return input.roundedCorners ? { frame: false } : { frame: false, roundedCorners: false };
}
