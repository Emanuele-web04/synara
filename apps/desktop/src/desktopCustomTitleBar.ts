// FILE: desktopCustomTitleBar.ts
// Purpose: Persist the Windows/Linux custom title bar preference for Electron boot.
// Layer: Desktop main process
// Depends on: filesystem; preference must be readable before BrowserWindow creation.

import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopCustomTitleBarMode } from "@synara/contracts";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import {
  defaultCustomTitleBarPreference,
  resolveDesktopCustomTitleBarMode,
  supportsCustomTitleBar,
} from "@synara/shared/desktopTitleBar";

export interface PersistedCustomTitleBarPreference {
  readonly version: 1;
  readonly enabled: boolean;
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
  return { version: 1, enabled: candidate.enabled };
}

export function readCustomTitleBarPreference(filePath: string): boolean | null {
  try {
    const parsed = parseCustomTitleBarPreference(JSON.parse(FS.readFileSync(filePath, "utf8")));
    return parsed?.enabled ?? null;
  } catch {
    return null;
  }
}

export function writeCustomTitleBarPreference(filePath: string, enabled: boolean): void {
  const payload: PersistedCustomTitleBarPreference = { version: 1, enabled };
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function resolveDesktopCustomTitleBarState(input: {
  readonly platform: string;
  readonly preference: boolean | null;
  readonly activeMode: DesktopCustomTitleBarMode;
}): {
  readonly supported: boolean;
  readonly preference: boolean;
  readonly active: boolean;
  readonly restartRequired: boolean;
  readonly mode: DesktopCustomTitleBarMode;
} {
  const supported = supportsCustomTitleBar(input.platform);
  const preference = supported
    ? (input.preference ?? defaultCustomTitleBarPreference(input.platform))
    : false;
  const mode = supported ? input.activeMode : "native-frame";
  const active = supported && mode !== "native-frame";
  return {
    supported,
    preference,
    active,
    restartRequired: supported && preference !== active,
    mode,
  };
}

export type DesktopTitleBarWindowOptions =
  | { readonly frame: false }
  | {
      readonly titleBarStyle: "hidden";
      readonly titleBarOverlay: { readonly color: string; readonly height: number };
    }
  | Record<string, never>;

export interface DesktopTitleBarConfiguration {
  readonly mode: DesktopCustomTitleBarMode;
  readonly windowOptions: DesktopTitleBarWindowOptions;
}

export function resolveDesktopTitleBarConfiguration(input: {
  readonly platform: NodeJS.Platform;
  readonly preference: boolean | null;
}): DesktopTitleBarConfiguration {
  const mode = resolveDesktopCustomTitleBarMode({
    platform: input.platform,
    preference: input.preference,
  });
  if (mode === "native-overlay") {
    return {
      mode,
      windowOptions: {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#00000000",
          height: CHAT_SURFACE_HEADER_HEIGHT_PX,
        },
      },
    };
  }
  if (mode === "renderer") {
    return { mode, windowOptions: { frame: false } };
  }
  return { mode, windowOptions: {} };
}
