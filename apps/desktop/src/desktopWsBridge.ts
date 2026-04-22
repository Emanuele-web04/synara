// FILE: desktopWsBridge.ts
// Purpose: Shares the desktop WebSocket bridge channel and env fallback rules.
// Exports: channel name plus helpers used by Electron main, preload, and tests.

export const DESKTOP_WS_URL_CHANNEL = "desktop:get-ws-url";

export function normalizeDesktopWsUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveDesktopWsUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (
    normalizeDesktopWsUrl(env.DPCODE_DESKTOP_WS_URL) ??
    normalizeDesktopWsUrl(env.T3CODE_DESKTOP_WS_URL)
  );
}
