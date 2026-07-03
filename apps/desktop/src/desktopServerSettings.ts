// FILE: desktopServerSettings.ts
// Purpose: Reads server-owned settings needed before the backend process starts.
// Layer: Desktop startup helper
// Depends on: server settings defaults from contracts and the shared data-dir layout.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

export function resolveDesktopServerSettingsPath(baseDir: string): string {
  return path.join(baseDir, "userdata", "settings.json");
}

// The desktop process needs this before the backend has loaded settings. Treat
// only an explicit persisted boolean as authoritative; all malformed/missing
// cases fall back to the server default.
export function readDesktopEnableWandySetting(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) {
    return DEFAULT_SERVER_SETTINGS.enableWandy;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return DEFAULT_SERVER_SETTINGS.enableWandy;
    }

    const enableWandy = (parsed as { readonly enableWandy?: unknown }).enableWandy;
    return typeof enableWandy === "boolean" ? enableWandy : DEFAULT_SERVER_SETTINGS.enableWandy;
  } catch {
    return DEFAULT_SERVER_SETTINGS.enableWandy;
  }
}
