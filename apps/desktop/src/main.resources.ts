// FILE: main.resources.ts
// Purpose: Resolve bundled resource and icon file paths across dev/packaged layouts.
// Layer: Desktop main process
// Exports: resolveResourcePath, resolveIconPath, resolveNotificationIconPath.

import * as FS from "node:fs";
import * as Path from "node:path";

export function resolveResourcePath(dirname: string, fileName: string): string | null {
  const candidates = [
    Path.join(dirname, "../resources", fileName),
    Path.join(dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveIconPath(dirname: string, ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(dirname, `icon.${ext}`);
}

export function resolveNotificationIconPath(dirname: string): string | null {
  if (process.platform === "darwin") {
    return null;
  }
  if (process.platform === "win32") {
    return resolveResourcePath(dirname, "synara.png") ?? resolveIconPath(dirname, "ico");
  }
  return resolveResourcePath(dirname, "synara.png") ?? resolveIconPath(dirname, "png");
}
