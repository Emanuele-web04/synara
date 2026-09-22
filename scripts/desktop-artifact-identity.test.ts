import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopRuntimeFlavor,
  synaraDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import { createDesktopArtifactIdentity } from "./lib/desktop-artifact-identity.ts";

describe("desktop artifact identity", () => {
  it.each(["mac", "linux", "win"] as const)(
    "preserves the production %s package and artifact names",
    (platform) => {
      const result = createDesktopArtifactIdentity({ platform, flavor: "production" });
      expect(result.packageMetadata).toEqual({
        name: "synara-desktop",
        productName: "Synara",
        synaraDesktopFlavor: "production",
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
