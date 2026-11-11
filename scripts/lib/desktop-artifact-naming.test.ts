import { describe, expect, it } from "vitest";

import {
  payloadArchLabel,
  retargetStagedEntry,
  stagedUpdaterManifestName,
  stagedUpdaterManifestSource,
} from "./desktop-artifact-naming.ts";

describe("desktop artifact naming", () => {
  it("keeps the native AppImage spelling for Intel and the matrix spelling elsewhere", () => {
    expect(payloadArchLabel("linux", "x64")).toBe("x86_64");
    expect(payloadArchLabel("linux", "arm64")).toBe("arm64");
    expect(payloadArchLabel("mac", "x64")).toBe("x64");
    expect(payloadArchLabel("win", "x64")).toBe("x64");
  });

  it("keeps one plain manifest per platform and retargets the secondary architecture", () => {
    expect(stagedUpdaterManifestName("mac", "arm64")).toBe("latest-mac.yml");
    expect(stagedUpdaterManifestName("mac", "x64")).toBe("latest-mac-x64.yml");
    expect(stagedUpdaterManifestName("mac", "universal")).toBe("latest-mac-universal.yml");
    expect(stagedUpdaterManifestName("linux", "x64")).toBe("latest-linux.yml");
    expect(stagedUpdaterManifestName("linux", "arm64")).toBe("latest-linux-arm64.yml");
    expect(stagedUpdaterManifestName("win", "x64")).toBe("latest.yml");
  });

  it("renames only the updater manifest entry", () => {
    expect(stagedUpdaterManifestSource("linux")).toBe("latest-linux.yml");
    expect(retargetStagedEntry("latest-linux.yml", "linux", "arm64")).toBe(
      "latest-linux-arm64.yml",
    );
    expect(retargetStagedEntry("latest-linux.yml", "linux", "x64")).toBe("latest-linux.yml");
    expect(retargetStagedEntry("Synara-1.5.1-arm64.AppImage", "linux", "arm64")).toBe(
      "Synara-1.5.1-arm64.AppImage",
    );
    expect(retargetStagedEntry("latest.yml", "win", "arm64")).toBe("latest.yml");
  });

  it("retargets the macOS manifest for Intel and leaves the arm64 name alone", () => {
    expect(retargetStagedEntry("latest-mac.yml", "mac", "x64")).toBe("latest-mac-x64.yml");
    expect(retargetStagedEntry("latest-mac.yml", "mac", "arm64")).toBe("latest-mac.yml");
    expect(retargetStagedEntry("latest-mac-x64.yml", "mac", "x64")).toBe("latest-mac-x64.yml");
    expect(retargetStagedEntry("Synara-1.5.1-x64.dmg", "mac", "x64")).toBe("Synara-1.5.1-x64.dmg");
  });
});
