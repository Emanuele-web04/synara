// FILE: pairingUrl.ts
// Purpose: Build fragment-only pairing links and validate origins for another device.
// Layer: Shared server + web URL utilities

/** Keep the one-time credential out of request URLs and server access logs. */
export function buildPairingUrl(baseUrl: string, credential: string): string {
  const url = new URL("/pair", baseUrl);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

/**
 * Accept an explicitly configured or selected HTTP origin, excluding addresses
 * that point back at the scanning device or cannot identify a listening host.
 * This does not discover a LAN address or prove network reachability.
 */
export function normalizeRemotePairingOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.port === "0"
    ) {
      return undefined;
    }
    const host = url.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "localhost.localdomain" ||
      /^(?:127|0)\./.test(host) ||
      host === "::" ||
      host === "::1" ||
      host === "::ffff:0:0" ||
      /^::ffff:7f[0-9a-f]{2}:/.test(host)
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
