import * as fs from "node:fs/promises";
import * as path from "node:path";

// String-level containment checks (path.resolve + path.relative) cannot see
// symlinks, so a link inside the workspace pointing outside it would pass and
// the subsequent open/readdir would follow it. Resolve both sides through the
// filesystem and re-check containment on the canonical paths. This also
// canonicalizes roots that are themselves behind symlinks (e.g. /tmp ->
// /private/tmp on macOS), so in-root symlinks keep working.
export async function resolveRealPathWithinRoot(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string | null> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(absolutePath),
  ]);
  if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) {
    return realTarget;
  }
  return null;
}
