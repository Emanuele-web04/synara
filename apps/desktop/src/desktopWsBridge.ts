export { DESKTOP_WS_URL_CHANNEL } from "./ipcChannels";

export function normalizeDesktopWsUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveDesktopWsUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  return normalizeDesktopWsUrl(env.SYNARA_DESKTOP_WS_URL);
}
