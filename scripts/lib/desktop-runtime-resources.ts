// FILE: desktop-runtime-resources.ts
// Purpose: Stages runtime resources without bundling installer-only artwork.
// Layer: Release/build helper

import { Effect, FileSystem, Path } from "effect";

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
    if (entry === "dmgly") continue;
    yield* fs.copy(path.join(buildResourcesDir, entry), path.join(runtimeResourcesDir, entry));
  }
});
