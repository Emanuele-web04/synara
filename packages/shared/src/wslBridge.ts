import { parseWindowsWslUncPath } from "./windowsProcess";

export interface WslWorkspace {
  readonly distribution: string;
  readonly linuxPath: string;
}

/** only for the supported \\wsl$ and \\wsl.localhost boundaries */
export function resolveWslWorkspace(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): WslWorkspace | null {
  return platform === "win32" ? parseWindowsWslUncPath(cwd) : null;
}

/** payloads receive the backend-native cwd; native Windows paths pass through */
export function resolveExecutionWorkingDirectory(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveWslWorkspace(cwd, platform)?.linuxPath ?? cwd;
}
