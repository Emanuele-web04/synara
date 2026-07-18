// FILE: desktopRendererTrust.ts
// Purpose: Defines the exact top-level renderer locations trusted with desktop-only IPC.
// Layer: Desktop main-process security utility

import { SYNARA_DESKTOP_SCHEME } from "@synara/shared/desktopIdentity";

export function isTrustedDesktopRendererUrl(
  value: string,
  developmentServerUrl: string | null,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return false;
  }

  if (developmentServerUrl) {
    try {
      return candidate.origin === new URL(developmentServerUrl).origin;
    } catch {
      return false;
    }
  }

  return candidate.protocol === `${SYNARA_DESKTOP_SCHEME}:` && candidate.hostname === "app";
}
