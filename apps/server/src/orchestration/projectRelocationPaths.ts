import { posix, win32 } from "node:path";
import {
  normalizeWorkspaceRootForComparison,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";

export function relocateProjectPath(
  value: string | null | undefined,
  previousRoot: string,
  nextRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | null | undefined {
  if (value == null) return value;
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(value) || !path.isAbsolute(previousRoot) || !path.isAbsolute(nextRoot)) {
    return value;
  }
  const comparable = (value: string) =>
    platform === "darwin" ? normalizeWorkspaceRootForComparison(value, { platform }) : value;
  const relative = path.relative(comparable(previousRoot), comparable(value));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return value;
  }
  return path.join(nextRoot, relative);
}

export function providerWorkspaceChanged(
  currentCwd: string | undefined,
  requestedCwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // ProviderSession.cwd is optional — missing metadata isn't proof of a move
  if (requestedCwd === undefined || currentCwd === undefined) return false;
  return !workspaceRootsEqual(currentCwd, requestedCwd, { platform });
}
