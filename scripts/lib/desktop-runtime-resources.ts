import { Effect, FileSystem, Path } from "effect";

// build-time output the app never resolves — DMG artwork and the icon catalog would ship megabytes unused
const BUNDLE_ONLY_RESOURCE_ENTRIES = new Set(["dmgly", "Assets.car", "Synara.icns"]);

export const stageDesktopRuntimeResources = Effect.fn("stageDesktopRuntimeResources")(function* (
  buildResourcesDir: string,
  runtimeResourcesDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // electron-builder excludes build resources; mirror only runtime assets
  const entries = yield* fs.readDirectory(buildResourcesDir);
  yield* fs.makeDirectory(runtimeResourcesDir, { recursive: true });
  for (const entry of entries) {
    if (BUNDLE_ONLY_RESOURCE_ENTRIES.has(entry)) continue;
    yield* fs.copy(path.join(buildResourcesDir, entry), path.join(runtimeResourcesDir, entry));
  }
});
