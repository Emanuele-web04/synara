import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { stageDesktopRuntimeResources } from "./desktop-runtime-resources.ts";

it.layer(NodeServices.layer)("stageDesktopRuntimeResources", (it) => {
  it.effect("preserves runtime assets while leaving installer artwork in build resources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "synara-runtime-resources-" });
      const buildResources = path.join(root, "resources");
      const runtimeResources = path.join(root, "prod-resources");
      const runtimeFiles = [
        "icon.icns",
        "icon.ico",
        "app-icon-macos.png",
        "app-icon-linux.png",
        "app-icon-windows.ico",
        "synara.png",
        "entitlements.mac.plist",
        "nested/runtime.dat",
      ];
      const installerFiles = ["dmgly/assets/dmg-background.png", "dmgly/assets/app-icon.png"];

      for (const file of [...runtimeFiles, ...installerFiles]) {
        const target = path.join(buildResources, file);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, `contents of ${file}`);
      }

      yield* stageDesktopRuntimeResources(buildResources, runtimeResources);

      for (const file of runtimeFiles) {
        assert.equal(
          yield* fs.readFileString(path.join(runtimeResources, file)),
          `contents of ${file}`,
        );
      }
      assert.equal(yield* fs.exists(path.join(runtimeResources, "dmgly")), false);
      for (const file of installerFiles) {
        assert.equal(
          yield* fs.readFileString(path.join(buildResources, file)),
          `contents of ${file}`,
        );
      }
    }).pipe(Effect.scoped),
  );
});
