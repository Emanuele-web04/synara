import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopRuntimeFlavor,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import { createDesktopArtifactIdentity } from "./lib/desktop-artifact-identity.ts";
import { createDesktopPlatformBuildConfig } from "./lib/desktop-platform-build-config.ts";

const require = createRequire(import.meta.url);
const requireFromBuilder = createRequire(require.resolve("electron-builder/package.json"));
const { AppInfo } = requireFromBuilder("app-builder-lib/out/appInfo.js");
const { default: FpmTarget } = requireFromBuilder("app-builder-lib/out/targets/FpmTarget.js");

describe("desktop artifact identity", () => {
  it.each(["production", "beta"] as const)(
    "supplies valid staged %s metadata to the real Debian package validator",
    async (flavor) => {
      const identity = createDesktopArtifactIdentity({ platform: "linux", flavor });
      const config = createDesktopPlatformBuildConfig({
        platform: "linux",
        target: "AppImage,deb",
        flavor,
      });
      // The generated staging directory has no Git checkout or development
      // package metadata from which electron-builder could infer these fields.
      const info = {
        metadata: { ...identity.packageMetadata, version: "1.0.1" },
        devMetadata: {},
        config: identity.buildConfig,
        repositoryInfo: Promise.resolve(null),
      };
      const metadata = await FpmTarget.prototype.computeFpmMetaInfoOptions.call({
        options: config.linux,
        packager: { info, appInfo: new AppInfo(info) },
      });

      expect(metadata).toEqual({
        name: flavor === "production" ? "synara-desktop" : "synara-desktop-beta",
        maintainer: "Emanuele Di Pietro <127427797+Emanuele-web04@users.noreply.github.com>",
        vendor: "Emanuele Di Pietro <127427797+Emanuele-web04@users.noreply.github.com>",
        url: "https://github.com/Emanuele-web04/synara",
      });
      expect(config.linux?.target).toEqual(["AppImage", "deb"]);
    },
  );

  it.each(["mac", "win"] as const)(
    "preserves the production %s package and artifact names",
    (platform) => {
      const result = createDesktopArtifactIdentity({ platform, flavor: "production" });
      expect(result.packageMetadata).toEqual({
        name: "synara-desktop",
        productName: "Synara",
        synaraDesktopFlavor: "production",
        homepage: "https://github.com/Emanuele-web04/synara",
        author: {
          name: "Emanuele Di Pietro",
          email: "127427797+Emanuele-web04@users.noreply.github.com",
        },
      });
      expect(result.buildConfig).toEqual({
        appId: "com.emanueledipietro.synara",
        productName: "Synara",
        artifactName: "Synara-${version}-${arch}.${ext}",
      });
      expect(result.releaseDirectoryName).toBe("release");
      expect(result.identity.usesScriptedUpdates).toBe(false);
    },
  );

  it.each(["canary", "cua"] as const)(
    "keeps packaged %s metadata, native identity, origin, storage and updater policy aligned",
    (flavor) => {
      const result = createDesktopArtifactIdentity({ platform: "mac", flavor });
      const packagedJson = JSON.parse(JSON.stringify(result.packageMetadata));
      const runtimeFlavor = resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        packagedFlavor: packagedJson.synaraDesktopFlavor,
        requestedFlavor: "production",
      });
      const runtimeIdentity = synaraDesktopIdentity(runtimeFlavor);
      expect(runtimeIdentity).toEqual(result.identity);
      expect(result.buildConfig.appId).toBe(runtimeIdentity.bundleId);
      expect(result.packageMetadata.productName).toBe(result.buildConfig.productName);
      expect(result.packageMetadata.name).toBe(`synara-desktop-${flavor}`);
      expect(result.buildConfig.protocols).toEqual([
        { name: runtimeIdentity.displayName, schemes: [runtimeIdentity.scheme] },
      ]);
      expect(runtimeIdentity.userDataDirectoryName).toBe(`synara-${flavor}`);
      expect(runtimeIdentity.defaultHomeDirectoryName).toBe(`.synara-${flavor}`);
      expect(runtimeIdentity.usesScriptedUpdates).toBe(true);
      expect(result.releaseDirectoryName).toBe(`release-${flavor}`);
      expect(result.buildConfig.artifactName).not.toBe("Synara-${version}-${arch}.${ext}");
    },
  );

  it.each(["canary", "cua"] as const)(
    "refuses %s on Windows until it has an isolated installer registration",
    (flavor) => {
      expect(() => createDesktopArtifactIdentity({ platform: "win", flavor })).toThrow(
        "macOS and Linux only",
      );
    },
  );
});
