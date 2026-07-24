// FILE: binaryResolution.ts
// Purpose: Locates the real provider binary on PATH, excluding the Synara shim
//          directory and the launcher itself (plan section 21.4).
// Layer: Standalone launcher
// Exports: resolveRealBinary.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolveRealBinaryInput {
  readonly command: string;
  readonly pathEnv: string | undefined;
  /** Directory containing the Synara shims; excluded from the search. */
  readonly shimDir: string;
  readonly platform?: NodeJS.Platform;
  readonly pathExtEnv?: string | undefined;
}

function canonicalize(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches PATH for the first executable named `command`, skipping the shim
 * directory and any candidate that canonicalizes into it (so a shim symlinked
 * elsewhere never launches itself). Honors Windows `PATHEXT`.
 */
export function resolveRealBinary(input: ResolveRealBinaryInput): string | null {
  const platform = input.platform ?? process.platform;
  const shimDirReal = canonicalize(input.shimDir) ?? path.resolve(input.shimDir);
  const searchDirs = (input.pathEnv ?? "")
    .split(path.delimiter)
    .filter((dir) => dir.length > 0)
    .filter((dir) => {
      const real = canonicalize(dir) ?? path.resolve(dir);
      return real !== shimDirReal;
    });

  const extensions =
    platform === "win32"
      ? (input.pathExtEnv ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)
      : [""];

  for (const dir of searchDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, input.command + extension.toLowerCase());
      const real = canonicalize(candidate);
      if (real === null) continue;
      if (path.dirname(real) === shimDirReal) continue;
      if (isExecutableFile(real, platform)) return real;
    }
  }
  return null;
}
