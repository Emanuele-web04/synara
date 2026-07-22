// FILE: islandHelperPath.ts
// Purpose: Resolves the native macOS island helper beside its development or packaged host.
// Layer: Desktop main-process path adapter

import * as Path from "node:path";

const ISLAND_HELPER_NAME = "synara-island-helper";

export interface DesktopIslandHelperPathInput {
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}

export function resolveDesktopIslandHelperPath(input: DesktopIslandHelperPathInput): string {
  if (input.isPackaged) {
    return Path.resolve(input.resourcesPath, "..", "Helpers", ISLAND_HELPER_NAME);
  }

  return Path.resolve(input.moduleDir, "..", ".electron-runtime", "island", ISLAND_HELPER_NAME);
}
