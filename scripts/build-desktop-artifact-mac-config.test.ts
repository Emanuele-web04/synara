import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  MAC_DEVICE_HELPER_STAGE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_ICON_ASSET_NAME,
  MAC_ICON_ASSETS_CAR_BUNDLE_PATH,
  MAC_ICON_ASSETS_CAR_STAGE_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MICROPHONE_USAGE_DESCRIPTION,
  validateDesktopNativeBuildHost,
  WINDOWS_INSTALLER_GUID,
} from "./lib/desktop-platform-build-config.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, false);
    assert.ok(config.afterSign?.endsWith("/mac-after-sign.cjs"));
    assert.equal(mac.identity, undefined);
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Helpers/synara-appsnap-helper");
    assert.deepStrictEqual(mac.binaries, [
      "Contents/Helpers/synara-appsnap-helper",
      "Contents/Resources/cua-driver/cua-driver",
    ]);
    assert.equal(
      mac.x64ArchFiles,
      "Contents/{Helpers/synara-appsnap-helper,Resources/cua-driver/cua-driver}",
    );
    assert.equal(
      MAC_APPSNAP_HELPER_STAGE_PATH,
      "apps/desktop/native/appsnap/build/synara-appsnap-helper",
    );
    assert.equal(MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/appsnap/build/**");
    assert.equal(config.files?.[0], "**/*");
    assert.ok(config.files?.includes(MAC_APPSNAP_HELPER_ASAR_EXCLUSION));
    assert.ok(config.files?.includes("!apps/desktop/resources/cua-driver/**"));
    assert.deepStrictEqual(config.extraFiles, [
      {
        from: "apps/desktop/resources/cua-driver",
        to: "Resources/cua-driver",
      },
      {
        from: "apps/desktop/native/appsnap/build/synara-appsnap-helper",
        to: "Helpers/synara-appsnap-helper",
      },
      {
        from: MAC_DEVICE_HELPER_STAGE_PATH,
        to: MAC_DEVICE_HELPER_RESOURCE_PATH,
      },
      {
        from: MAC_ICON_ASSETS_CAR_STAGE_PATH,
        to: MAC_ICON_ASSETS_CAR_BUNDLE_PATH,
      },
    ]);
    assert.equal(MAC_ICON_ASSETS_CAR_STAGE_PATH, "apps/desktop/resources/Assets.car");
    assert.equal(MAC_ICON_ASSETS_CAR_BUNDLE_PATH, "Resources/Assets.car");
    // macOS 26 reads the layered icon out of Assets.car; without this key the
    // bundle falls back to the flat ICNS and never gets the glass material.
    assert.equal(extendInfo.CFBundleIconName, MAC_ICON_ASSET_NAME);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(
      extendInfo.NSScreenCaptureUsageDescription,
      "Synara captures the windows you authorize for Computer use.",
    );
    assert.equal(
      extendInfo.NSAccessibilityUsageDescription,
      "Synara controls the windows you authorize for Computer use.",
    );
  });

  it("leaves the DMG container unsigned for build-only macOS artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.deepStrictEqual(config.dmg, {
      background: "apps/desktop/resources/dmgly/assets/dmg-background.png",
      window: { width: 642, height: 406 },
      iconSize: 128,
      contents: [
        { x: 172, y: 135, type: "file" },
        { x: 514, y: 241, type: "link", path: "/Applications" },
      ],
      sign: false,
      writeUpdateInfo: false,
    });
    assert.equal(config.mac?.identity, undefined);
  });

  it("seals isolated local app bundles with the existing nested signing policy", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "zip",
      signed: false,
      adHocSign: true,
    });

    assert.equal(config.mac?.identity, "-");
    assert.equal(config.mac?.timestamp, "none");
    assert.equal(config.mac?.hardenedRuntime, false);
    assert.equal(config.mac?.notarize, false);
    assert.equal(config.mac?.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(config.mac?.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(config.dmg?.sign, false);
  });

  it("never replaces release signing with local ad-hoc signing", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "zip",
      signed: true,
      adHocSign: true,
    });

    assert.equal(config.mac?.identity, undefined);
    assert.equal(config.mac?.timestamp, undefined);
    assert.equal(config.mac?.hardenedRuntime, true);
    assert.equal(config.mac?.notarize, false);
    assert.ok(config.afterSign?.endsWith("/mac-after-sign.cjs"));
  });

  it("packages the Linux driver as an external executable and leaves Windows unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
    });
    const win = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
      windowsAzureSignOptions: { publisherName: "Synara" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.extraFiles, undefined);
    assert.deepStrictEqual(linux.extraResources, [
      { from: "apps/desktop/resources/cua-driver", to: "cua-driver" },
    ]);
    assert.ok(linux.files?.includes("!apps/desktop/resources/cua-driver/**"));
    assert.ok(linux.files?.includes("!apps/desktop/prod-resources/cua-driver/**"));
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
    assert.equal(win.extraFiles, undefined);
    assert.equal(win.extraResources, undefined);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(WINDOWS_INSTALLER_GUID, "368107a8-afe6-5db5-ab3b-d4f331684868");
    assert.deepStrictEqual(win.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      publisherName: "Synara",
      azureSignOptions: { publisherName: "Synara" },
    });
  });

  it("omits Azure signing options for unsigned build-only artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
    });
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

  it("requires a macOS host for the native Swift AppSnap helper", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "mac",
        arch: "universal",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      null,
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "linux",
      hostArch: "arm64",
    });
    assert.ok(issue?.includes("Build mac/arm64 on macOS"));
  });
});
