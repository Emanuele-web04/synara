import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MICROPHONE_USAGE_DESCRIPTION,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  parseXcodeMajorVersion,
  supportsMacIconComposerPackaging,
  validateDesktopNativeBuildHost,
} from "./lib/desktop-platform-build-config.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      hasMacIconComposer: false,
    });
    const mac = config.mac as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(config.afterPack, undefined);
    assert.equal(config.dmg, undefined);
  });

  it("preserves the icon composer packaging path for macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      hasMacIconComposer: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.equal(mac.icon, "icon.icon");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(extendInfo.CFBundleIconFile, "icon.icns");
    assert.equal(config.afterPack, "./electron-builder-after-pack.cjs");
    assert.deepStrictEqual(config.dmg, { icon: "icon.icns" });
  });

  it("leaves non-macOS platform configs unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
      hasMacIconComposer: false,
    });
    const win = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
      hasMacIconComposer: false,
      windowsAzureSignOptions: { publisherName: "T3 Tools" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.afterPack, undefined);
    assert.deepStrictEqual(linux.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "synara",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "synara",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      azureSignOptions: { publisherName: "T3 Tools" },
    });
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
      hasMacIconComposer: false,
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [...NODE_PTY_ASAR_UNPACK_GLOBS]);
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });

  it("keeps separate macOS sources for modern and legacy rounded icons", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconComposer, "assets/prod/black-macos.icon");
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/prod/black-macos-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      "assets/prod/black-macos-legacy-1024.png",
    );
  });

  it("uses Icon Composer packaging only on supported Xcode hosts", () => {
    assert.equal(parseXcodeMajorVersion("Xcode 26.6\nBuild version 17F113"), 26);
    assert.equal(parseXcodeMajorVersion("not xcode"), null);
    assert.equal(
      supportsMacIconComposerPackaging({
        hostPlatform: "darwin",
        xcodebuildVersionOutput: "Xcode 26.0\nBuild version 17A000",
      }),
      true,
    );
    assert.equal(
      supportsMacIconComposerPackaging({
        hostPlatform: "darwin",
        xcodebuildVersionOutput: "Xcode 16.4\nBuild version 16F6",
      }),
      false,
    );
    assert.equal(
      supportsMacIconComposerPackaging({
        hostPlatform: "linux",
        xcodebuildVersionOutput: "Xcode 26.0\nBuild version 17A000",
      }),
      false,
    );
  });
});
