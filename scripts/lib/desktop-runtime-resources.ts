// FILE: desktop-runtime-resources.ts
// Purpose: Stages runtime resources without bundling installer-only artwork.
// Layer: Release/build helper

import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";
import { Effect, FileSystem, Path } from "effect";

import { BETA_ASSET_PATHS, BRAND_ASSET_PATHS } from "./brand-assets.ts";

// Resources read by the installer or macOS bundle: DMG artwork, the compiled
// icon, and localized permission descriptions. Keep these outside app.asar;
// the application never resolves them through its runtime resource directory.
const BUNDLE_ONLY_RESOURCE_ENTRIES = new Set([
  "dmgly",
  "Assets.car",
  "Synara.icns",
  "localizations",
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
  if (options) {
    // Root notices are outside buildResources and would otherwise be omitted
    // from every packaged app. Keep the full text in the runtime resource tree.
    for (const notice of ["LICENSE", "ATTRIBUTION.md"]) {
      yield* fs.copyFile(
        path.join(options.repositoryRoot, notice),
        path.join(runtimeResourcesDir, notice),
      );
    }
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
