// FILE: remoteAccessSettings.ts
// Purpose: Validates and persists the desktop-owned Mobile Companion settings.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

export const DEFAULT_COMPANION_PORT = 3773;
export const REMOTE_ACCESS_SETTINGS_FILE_NAME = "desktop-remote-access.json";
export const MIN_UNPRIVILEGED_PORT = 1024;
export const MAX_TCP_PORT = 65_535;

export interface DesktopRemoteAccessSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly port: number;
  readonly trustedOrigin: string | null;
  readonly keepRunningOnClose: boolean;
  readonly launchAtLogin: boolean;
  /** Internal UX marker so hiding to the tray is explained once, not on every close. */
  readonly keepRunningNoticeShown: boolean;
}

export interface DesktopRemoteAccessSettingsPatch {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly trustedOrigin?: string | null;
  readonly keepRunningOnClose?: boolean;
  readonly launchAtLogin?: boolean;
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: DesktopRemoteAccessSettings = {
  version: 1,
  enabled: false,
  port: DEFAULT_COMPANION_PORT,
  trustedOrigin: null,
  keepRunningOnClose: false,
  launchAtLogin: false,
  keepRunningNoticeShown: false,
};

export class RemoteAccessSettingsValidationError extends Error {
  override readonly name = "RemoteAccessSettingsValidationError";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeTrustedTailnetOrigin(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RemoteAccessSettingsValidationError(
      "Trusted origin must be an exact HTTPS Tailnet origin.",
    );
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RemoteAccessSettingsValidationError(
      "Trusted origin must be a valid HTTPS URL.",
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    hostname.includes("*") ||
    !hostname.endsWith(".ts.net")
  ) {
    throw new RemoteAccessSettingsValidationError(
      "Trusted origin must be an exact HTTPS *.ts.net origin without a path, query, or fragment.",
    );
  }

  return url.origin;
}

function validatePort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_UNPRIVILEGED_PORT ||
    value > MAX_TCP_PORT
  ) {
    throw new RemoteAccessSettingsValidationError(
      `Companion port must be an integer from ${MIN_UNPRIVILEGED_PORT} to ${MAX_TCP_PORT}.`,
    );
  }
  return value;
}

export function parseRemoteAccessSettings(value: unknown): DesktopRemoteAccessSettings | null {
  if (!isPlainRecord(value) || value.version !== 1) return null;

  try {
    if (
      typeof value.enabled !== "boolean" ||
      typeof value.keepRunningOnClose !== "boolean" ||
      typeof value.launchAtLogin !== "boolean"
    ) {
      return null;
    }

    return {
      version: 1,
      enabled: value.enabled,
      port: validatePort(value.port),
      trustedOrigin: normalizeTrustedTailnetOrigin(
        value.trustedOrigin === undefined ? null : (value.trustedOrigin as string | null),
      ),
      keepRunningOnClose: value.keepRunningOnClose,
      launchAtLogin: value.launchAtLogin,
      // Added after the first settings version shipped; defaulting keeps the file additive.
      keepRunningNoticeShown:
        typeof value.keepRunningNoticeShown === "boolean"
          ? value.keepRunningNoticeShown
          : false,
    };
  } catch {
    return null;
  }
}

export function applyRemoteAccessSettingsPatch(
  current: DesktopRemoteAccessSettings,
  value: unknown,
): DesktopRemoteAccessSettings {
  if (!isPlainRecord(value)) {
    throw new RemoteAccessSettingsValidationError("Remote access settings must be an object.");
  }

  const allowedKeys = new Set([
    "enabled",
    "port",
    "trustedOrigin",
    "keepRunningOnClose",
    "launchAtLogin",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new RemoteAccessSettingsValidationError(`Unknown remote access setting: ${key}`);
    }
  }

  const readBoolean = (key: keyof DesktopRemoteAccessSettingsPatch, fallback: boolean) => {
    const next = value[key];
    if (next === undefined) return fallback;
    if (typeof next !== "boolean") {
      throw new RemoteAccessSettingsValidationError(`${key} must be a boolean.`);
    }
    return next;
  };

  const enabled = readBoolean("enabled", current.enabled);
  // Enabling remote access is itself the opt-in to the plan's tray default. An explicit
  // keepRunningOnClose value always wins.
  const keepRunningOnClose = readBoolean(
    "keepRunningOnClose",
    !current.enabled && enabled ? true : current.keepRunningOnClose,
  );

  let trustedOrigin = current.trustedOrigin;
  if (Object.hasOwn(value, "trustedOrigin")) {
    if (value.trustedOrigin !== null && typeof value.trustedOrigin !== "string") {
      throw new RemoteAccessSettingsValidationError(
        "trustedOrigin must be an HTTPS Tailnet origin or null.",
      );
    }
    trustedOrigin = normalizeTrustedTailnetOrigin(value.trustedOrigin as string | null);
  }

  return {
    version: 1,
    enabled,
    port: Object.hasOwn(value, "port") ? validatePort(value.port) : current.port,
    trustedOrigin,
    keepRunningOnClose,
    launchAtLogin: readBoolean("launchAtLogin", current.launchAtLogin),
    keepRunningNoticeShown: current.keepRunningNoticeShown,
  };
}

export function resolveRemoteAccessSettingsPath(stateDirectory: string): string {
  return Path.join(stateDirectory, REMOTE_ACCESS_SETTINGS_FILE_NAME);
}

export function readRemoteAccessSettings(settingsPath: string): DesktopRemoteAccessSettings {
  try {
    const stats = FS.statSync(settingsPath);
    if (!stats.isFile() || stats.size > 64 * 1024) return DEFAULT_REMOTE_ACCESS_SETTINGS;
    return (
      parseRemoteAccessSettings(JSON.parse(FS.readFileSync(settingsPath, "utf8"))) ??
      DEFAULT_REMOTE_ACCESS_SETTINGS
    );
  } catch {
    return DEFAULT_REMOTE_ACCESS_SETTINGS;
  }
}

export function writeRemoteAccessSettings(
  settingsPath: string,
  settings: DesktopRemoteAccessSettings,
): void {
  const validated = parseRemoteAccessSettings(settings);
  if (!validated) {
    throw new RemoteAccessSettingsValidationError("Refusing to persist invalid remote settings.");
  }

  const parentPath = Path.dirname(settingsPath);
  const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(parentPath, { recursive: true });
  try {
    FS.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    FS.renameSync(temporaryPath, settingsPath);
  } finally {
    FS.rmSync(temporaryPath, { force: true });
  }
}

export function shouldKeepDesktopRunning(settings: DesktopRemoteAccessSettings): boolean {
  return settings.enabled && settings.keepRunningOnClose;
}

export function shouldQuitAfterLastWindowClosed(input: {
  readonly platform: NodeJS.Platform;
  readonly settings: DesktopRemoteAccessSettings;
  readonly trayAvailable: boolean;
}): boolean {
  if (shouldKeepDesktopRunning(input.settings)) return !input.trayAvailable;
  if (input.platform !== "darwin") return true;
  // Preserve normal macOS no-window behavior unless the user explicitly opted out
  // of keeping an enabled Companion backend alive.
  return input.settings.enabled;
}

export function applyRemoteAccessBackendEnvironment(
  base: NodeJS.ProcessEnv,
  settings: DesktopRemoteAccessSettings,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...base,
    SYNARA_HOST: "127.0.0.1",
  };
  delete environment.SYNARA_COMPANION_ENABLED;
  delete environment.SYNARA_PUBLIC_URL;
  // Remove the feature-branch-only variable so a parent shell cannot revive
  // the retired origin path after the server standardized on SYNARA_PUBLIC_URL.
  delete environment.SYNARA_TRUSTED_ORIGIN;
  if (settings.enabled) {
    environment.SYNARA_COMPANION_ENABLED = "1";
    if (settings.trustedOrigin) environment.SYNARA_PUBLIC_URL = settings.trustedOrigin;
  }
  return environment;
}

export function remoteAccessRequiresBackendRestart(
  previous: DesktopRemoteAccessSettings,
  next: DesktopRemoteAccessSettings,
): boolean {
  if (previous.enabled !== next.enabled) return true;
  if (!previous.enabled && !next.enabled) return false;
  return previous.port !== next.port || previous.trustedOrigin !== next.trustedOrigin;
}
