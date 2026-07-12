import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { isMacPlatform, isWindowsPlatform } from "./utils";

export function getLocalFoldersGroupLabel(homeDir: string | null, platform: string): string {
  if (homeDir && isWindowsAbsolutePath(homeDir)) {
    return "Folders on this PC";
  }
  if (/^\/Users(?:\/|$)/i.test(homeDir ?? "")) {
    return "Folders on this Mac";
  }
  if (isWindowsPlatform(platform)) {
    return "Folders on this PC";
  }
  if (isMacPlatform(platform)) {
    return "Folders on this Mac";
  }
  return "Folders on this System";
}
