import { t } from "~/i18n";
import { isMacPlatform, isWindowsPlatform } from "./utils";

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
}

export function getLocalFoldersGroupLabel(
  homeDir: string | null,
  platform: string,
  translate: typeof t = t,
): string {
  if (homeDir && isWindowsAbsolutePath(homeDir)) {
    return translate("workspace:foldersOnPc");
  }
  if (/^\/Users(?:\/|$)/.test(homeDir ?? "")) {
    return translate("workspace:foldersOnMac");
  }
  if (homeDir?.startsWith("/")) {
    return translate("workspace:foldersOnSystem");
  }
  if (isWindowsPlatform(platform)) {
    return translate("workspace:foldersOnPc");
  }
  if (isMacPlatform(platform)) {
    return translate("workspace:foldersOnMac");
  }
  return translate("workspace:foldersOnSystem");
}
