import type { WebContents } from "electron";
import {
  SYNARA_BETA_DESKTOP_SCHEME,
  SYNARA_CANARY_DESKTOP_SCHEME,
  SYNARA_CUA_DESKTOP_SCHEME,
  SYNARA_DESKTOP_SCHEME,
  SYNARA_REMOTE_DESKTOP_SCHEME,
} from "@synara/shared/desktopIdentity";

/** Copy buttons share the OS clipboard; background reads remain denied. */
export function isClipboardWritePermission(
  requester: Pick<WebContents, "isDestroyed" | "getURL"> | null,
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; embeddingOrigin?: string },
  requestingOrigin?: string,
): boolean {
  if (
    permission !== "clipboard-sanitized-write" ||
    !requester ||
    requester.isDestroyed() ||
    details.isMainFrame === false
  )
    return false;
  try {
    // Chromium enforces document focus. Native window focus may already have
    // returned to the composer when an asynchronous copy requests permission.
    const page = new URL(requester.getURL());
    const trustedScheme =
      page.protocol === `${SYNARA_DESKTOP_SCHEME}:` ||
      page.protocol === `${SYNARA_CANARY_DESKTOP_SCHEME}:` ||
      page.protocol === `${SYNARA_CUA_DESKTOP_SCHEME}:` ||
      page.protocol === `${SYNARA_BETA_DESKTOP_SCHEME}:` ||
      page.protocol === `${SYNARA_REMOTE_DESKTOP_SCHEME}:`;
    if (trustedScheme && (page.host !== "app" || page.username || page.password)) return false;
    if (
      page.protocol !== "https:" &&
      !trustedScheme &&
      !(page.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname))
    )
      return false;
    return [requestingOrigin, details.requestingUrl, details.embeddingOrigin].every((origin) => {
      if (!origin) return true;
      const source = new URL(origin);
      // Custom desktop schemes have an opaque URL.origin; compare their real authority.
      return trustedScheme
        ? source.protocol === page.protocol &&
            source.host === page.host &&
            !source.username &&
            !source.password
        : source.origin === page.origin;
    });
  } catch {
    return false;
  }
}
