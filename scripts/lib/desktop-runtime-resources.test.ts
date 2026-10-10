import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { BETA_ASSET_PATHS, BRAND_ASSET_PATHS } from "./brand-assets.ts";

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

      yield* stageDesktopRuntimeResources(buildResources, runtimeResources, {
        flavor: "production",
        repositoryRoot: root,
      });
      assert.equal(yield* fs.exists(path.join(runtimeResources, "dock-icon-beta.png")), false);

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
  it.effect("keeps Beta picker artwork distinct without replacing its bundled brand", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "synara-beta-icon-resources-" });
      const buildResources = path.join(root, "build");
      const runtimeResources = path.join(root, "runtime");
      const repositoryRoot = path.join(root, "repository");
      const artwork = [
        ["apps/desktop/resources/dock-icon.png", "white default"],
        ["apps/desktop/resources/dock-icon-dark.png", "black dark"],
        [BETA_ASSET_PATHS.betaMacIconPng, "blue 3D beta"],
        [BRAND_ASSET_PATHS.productionLinuxIconPng, "stable linux default"],
        [BRAND_ASSET_PATHS.productionWindowsIconIco, "stable windows default"],
      ];
      for (const [file, contents] of artwork) {
        const target = path.join(repositoryRoot, file!);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, contents!);
      }
      yield* fs.makeDirectory(buildResources, { recursive: true });
      for (const file of [
        "dock-icon.png",
        "dock-icon-dark.png",
        "dock-icon-beta.png",
        "icon.png",
        "icon.ico",
      ]) {
        yield* fs.writeFileString(path.join(buildResources, file), "blue bundled brand");
      }
      yield* stageDesktopRuntimeResources(buildResources, runtimeResources, {
        flavor: "beta",
        repositoryRoot,
      });
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "dock-icon.png")),
        "white default",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "dock-icon-dark.png")),
        "black dark",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "dock-icon-beta.png")),
        "blue 3D beta",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "app-icon-default-linux.png")),
        "stable linux default",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "app-icon-default-windows.ico")),
        "stable windows default",
      );
      assert.equal(
        yield* fs.readFileString(path.join(buildResources, "dock-icon.png")),
        "blue bundled brand",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "icon.png")),
        "blue bundled brand",
      );
      assert.equal(
        yield* fs.readFileString(path.join(runtimeResources, "icon.ico")),
        "blue bundled brand",
      );
    }).pipe(Effect.scoped),
  );
});
