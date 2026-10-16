// Renderer branding follows the packaged protocol defined by desktopIdentity.
import { SYNARA_REMOTE_DESKTOP_SCHEME } from "@synara/shared/desktopIdentity";

export const APP_BASE_NAME = "Synara";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "synara-canary:";
const isBetaDesktop = typeof window !== "undefined" && window.location?.protocol === "synara-beta:";
/** Shared flavor check for app branding and hosted Remote sign-in choices. */
export function isRemoteDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location?.protocol === `${SYNARA_REMOTE_DESKTOP_SCHEME}:`
  );
}
export const APP_DISPLAY_NAME = isRemoteDesktop()
  ? "Synara Remote"
  : isCanaryDesktop
    ? "Synara Canary"
    : isBetaDesktop
      ? "Synara Beta"
      : import.meta.env.DEV
        ? `${APP_BASE_NAME} (Dev)`
        : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
