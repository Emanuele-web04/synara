// FILE: desktop-runtime-resources.ts
// Purpose: Stages runtime resources without bundling installer-only artwork.
// Layer: Release/build helper

import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";
import { Effect, FileSystem, Path } from "effect";

import { BETA_ASSET_PATHS, BRAND_ASSET_PATHS } from "./brand-assets.ts";

// Build-time output and external executables that only the app bundle reads
// (via extraFiles/extraResources): the DMG artwork, the compiled Icon Composer
// catalog and its ICNS, and helper binaries. Copying them into prod-resources
// would duplicate megabytes of assets inside app.asar that the app never resolves.
const BUNDLE_ONLY_RESOURCE_ENTRIES = new Set([
  "dmgly",
  "Assets.car",
  "Synara.icns",
  "cua-driver",
  "cloudflared",
]);

export const stageDesktopRuntimeResources = Effect.fn("stageDesktopRuntimeResources")(function* (
  buildResourcesDir: string,
  runtimeResourcesDir: string,
  options?: { readonly flavor: SynaraPackagedDesktopFlavor; readonly repositoryRoot: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // electron-builder excludes build resources from the app; mirror only runtime assets.
  const entries = yield* fs.readDirectory(buildResourcesDir);
  yield* fs.makeDirectory(runtimeResourcesDir, { recursive: true });
  for (const entry of entries) {
    if (BUNDLE_ONLY_RESOURCE_ENTRIES.has(entry)) continue;
    yield* fs.copy(path.join(buildResourcesDir, entry), path.join(runtimeResourcesDir, entry));
  }
  if (options?.flavor === "beta") {
    // Bundle branding stays blue. Explicit picker choices use separate runtime
    // assets so Default, Dark and Beta do not all resolve to the same artwork.
    const overrides = [
      ["apps/desktop/resources/dock-icon.png", "dock-icon.png"],
      ["apps/desktop/resources/dock-icon-dark.png", "dock-icon-dark.png"],
      [BETA_ASSET_PATHS.betaMacIconPng, "dock-icon-beta.png"],
      [BRAND_ASSET_PATHS.productionLinuxIconPng, "app-icon-default-linux.png"],
      [BRAND_ASSET_PATHS.productionWindowsIconIco, "app-icon-default-windows.ico"],
    ] as const;
    for (const [source, target] of overrides) {
      yield* fs.copyFile(
        path.join(options.repositoryRoot, source),
        path.join(runtimeResourcesDir, target),
      );
    }
  }
});
