// FILE: pairingUrl.ts
// Purpose: Build /pair URLs with the credential in the hash so it never reaches server logs.
// Layer: Shared runtime utilities (server + web)
// Exports: buildPairingUrl

/**
 * The credential travels in the URL hash so it never reaches server logs; the
 * `/pair` route exchanges it for a session. Used by the server's startup
 * pairing link and the settings "Pair a device" card so the two cannot drift.
 */
export function buildPairingUrl(origin: string, credential: string): string {
  const url = new URL("/pair", origin);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}
