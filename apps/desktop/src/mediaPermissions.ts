// FILE: mediaPermissions.ts
// Purpose: Centralizes desktop media-permission guards for microphone capture.
// Layer: Desktop permission helper
// Exports: shouldAllowMediaPermissionRequest
// Depends on: Electron permission-request detail shape.

// Electron marks `mediaTypes` as optional, so audio-only requests may omit it.
// Treat a missing value as "potentially audio" so macOS can still show the system prompt.
export function shouldAllowMediaPermissionRequest(details: unknown): boolean {
  const mediaTypes =
    typeof details === "object" &&
    details !== null &&
    "mediaTypes" in details &&
    Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : null;
  if (!mediaTypes || mediaTypes.length === 0) {
    return true;
  }
  return mediaTypes.includes("audio");
}
