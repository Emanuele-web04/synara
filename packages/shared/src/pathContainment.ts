// FILE: pathContainment.ts
// Purpose: Native-path containment check for already-resolved filesystem paths.
// Layer: Shared platform runtime (node:path; not for browser bundles)
// Exports: isPathInside

import path from "node:path";

/**
 * True when `child` is `parent` itself or lies beneath it. The check is lexical:
 * resolve both paths first, and realpath them wherever a symlink could escape.
 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
