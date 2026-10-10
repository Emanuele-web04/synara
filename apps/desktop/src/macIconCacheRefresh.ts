import * as Path from "node:path";

// pure path/version logic lives here; file IO, bundle touch, and lsregister stay in main.ts so this is unit-testable without booting Electron

export const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

const LAUNCH_VERSION_RECORD_FILENAME = "last-launch-version.json";

export function resolveLaunchVersionRecordPath(userDataPath: string): string {
  return Path.join(userDataPath, LAUNCH_VERSION_RECORD_FILENAME);
}

export function parseLastLaunchVersion(rawContents: string | null): string | null {
  if (rawContents === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawContents);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const value = (parsed as { version?: unknown }).version;
      return typeof value === "string" ? value : null;
    }
  } catch {}
  return null;
}

export function serializeLaunchVersionRecord(version: string): string {
  return `${JSON.stringify({ version }, null, 2)}\n`;
}

// a null previous version counts as a change — users already stuck on a stale cached icon get fixed by the first update carrying this code
export function shouldRefreshIconCache(
  previousVersion: string | null,
  currentVersion: string,
): boolean {
  return previousVersion !== currentVersion;
}

export function resolveMacAppBundlePath(
  execPath: string,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "darwin") {
    return null;
  }
  const bundlePath = Path.resolve(execPath, "..", "..", "..");
  return bundlePath.endsWith(".app") ? bundlePath : null;
}
