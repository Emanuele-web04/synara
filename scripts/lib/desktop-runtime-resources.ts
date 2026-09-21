// FILE: desktop-runtime-resources.ts
// Purpose: Stages runtime resources without bundling installer-only artwork.
// Layer: Release/build helper

import { Effect, FileSystem, Path } from "effect";

// Build-time output that only the app bundle reads: the DMG artwork, plus the
// compiled Icon Composer catalog and its ICNS, which macOS loads from
// Contents/Resources. Copying them into the runtime tree would ship megabytes
// of artwork the app never resolves.
const BUNDLE_ONLY_RESOURCE_ENTRIES = new Set(["dmgly", "Assets.car", "Synara.icns"]);

export const stageDesktopRuntimeResources = Effect.fn("stageDesktopRuntimeResources")(function* (
  buildResourcesDir: string,
  runtimeResourcesDir: string,
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
});
