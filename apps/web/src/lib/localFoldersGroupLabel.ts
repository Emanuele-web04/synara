import { isMacPlatform, isWindowsPlatform } from "./utils";

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
}

export function getLocalFoldersGroupLabel(homeDir: string | null, platform: string): string {
  if (homeDir && isWindowsAbsolutePath(homeDir)) {
    return "Folders on this PC";
  }
  if (/^\/Users(?:\/|$)/.test(homeDir ?? "")) {
    return "Folders on this Mac";
  }
  if (homeDir?.startsWith("/")) {
    return "Folders on this System";
  }
  if (isWindowsPlatform(platform)) {
    return "Folders on this PC";
  }
  if (isMacPlatform(platform)) {
    return "Folders on this Mac";
  }
  return "Folders on this System";
}
