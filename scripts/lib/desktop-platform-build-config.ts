// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import { fileURLToPath } from "node:url";

import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";

import {
  createDesktopBundleFilePatterns,
  preserveDependencyDiagnostics,
} from "./desktop-bundle-files.ts";

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = "Contents/Helpers/synara-appsnap-helper";
export const MAC_DEVICE_HELPER_STAGE_PATH = "apps/server/dist/device-helper";
export const MAC_DEVICE_HELPER_RESOURCE_PATH = "Resources/device-helper";
export const WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
// Asset catalog name of the compiled Icon Composer icon. macOS 26 reads
// CFBundleIconName out of Assets.car and renders that layered icon with the
// Liquid Glass material; older releases ignore it and keep using the ICNS.
export const MAC_ICON_ASSET_NAME = "Synara";
export const MAC_ICON_COMPOSER_DEPLOYMENT_TARGET = "26.0";
export const MAC_ICON_ASSETS_CAR_STAGE_PATH = "apps/desktop/resources/Assets.car";
export const MAC_ICON_ASSETS_CAR_BUNDLE_PATH = "Resources/Assets.car";
export const WINDOWS_BETA_INSTALLER_GUID = "a8e63b48-d4f3-4db5-9e12-368107afe65d";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;

export interface DesktopPlatformBuildConfig {
  readonly afterSign?: string;
  readonly afterPack?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly extraResources?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly signed?: boolean;
  /** Seal isolated local bundles without selecting a release certificate. */
  readonly adHocSign?: boolean;
  readonly windowsAzureSignOptions?: Record<string, string>;
  readonly flavor?: SynaraPackagedDesktopFlavor | undefined;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include the native Swift AppSnap helper.",
      `Build mac/${input.arch} on macOS so the helper can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const report =
    process.platform === "linux"
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : undefined;
  const files = createDesktopBundleFilePatterns(input.platform, {
    diagnostics: preserveDependencyDiagnostics(process.env),
    linuxGlibc: typeof report?.header?.glibcVersionRuntime === "string",
  });
  const nativePackaging = { asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS], files };

  if (input.platform === "mac") {
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: input.signed === true,
      // The mandatory afterSign hook splits Apple upload/wait timings and
      // staples the app before electron-builder creates either container.
      notarize: false,
      // Use electron-builder's per-file signing pass, including the inherited
      // entitlements. Leaving only Electron's linker signature does not bind
      // the app's actual identity or seal its Info.plist and resources.
      ...(input.adHocSign === true && input.signed !== true
        ? { identity: "-", timestamp: "none" }
        : {}),
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Resources/cua-driver/cua-driver"],
      // The universal build stages the same pre-lipo'd helper in both app trees.
      // @electron/universal needs this pattern to preserve that existing fat binary.
      x64ArchFiles: "Contents/{Helpers/synara-appsnap-helper,Resources/cua-driver/cua-driver}",
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
        NSScreenCaptureUsageDescription:
          "Synara captures the windows you authorize for Computer use.",
        NSAccessibilityUsageDescription:
          "Synara controls the windows you authorize for Computer use.",
        NSLocalNetworkUsageDescription:
          "Synara connects to the browsers it drives on this Mac so agents can browse in the background.",
        CFBundleIconName: MAC_ICON_ASSET_NAME,
      },
    } satisfies Record<string, unknown>;

    return {
      ...nativePackaging,
      ...(input.signed === true
        ? {
            afterPack: fileURLToPath(new URL("./mac-after-pack.cjs", import.meta.url)),
            afterSign: fileURLToPath(new URL("./mac-after-sign.cjs", import.meta.url)),
          }
        : {}),
      dmg: {
        background: "apps/desktop/resources/dmgly/assets/dmg-background.png",
        window: { width: 642, height: 406 },
        iconSize: 128,
        contents: [
          // Omit path so electron-builder uses the packaged app and its actual filename.
          { x: 172, y: 135, type: "file" },
          { x: 514, y: 241, type: "link", path: "/Applications" },
        ],
        sign: input.signed === true,
        // The signed release flow notarizes and staples the DMG after electron-builder exits.
        // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
        // macOS auto-updates use the separately finalized ZIP artifact.
        writeUpdateInfo: false,
      },
      files: [...files, MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/resources/cua-driver/**"],
      extraFiles: [
        { from: "apps/desktop/resources/cua-driver", to: "Resources/cua-driver" },
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
          to: "Helpers/synara-appsnap-helper",
        },
        {
          from: MAC_DEVICE_HELPER_STAGE_PATH,
          to: MAC_DEVICE_HELPER_RESOURCE_PATH,
        },
        // electron-builder only knows how to place an ICNS; the compiled asset
        // catalog has to be copied into Contents/Resources by hand.
        {
          from: MAC_ICON_ASSETS_CAR_STAGE_PATH,
          to: MAC_ICON_ASSETS_CAR_BUNDLE_PATH,
        },
      ],
      mac,
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      // The driver is spawned by path; an executable inside app.asar cannot
      // serve that path. Keep the staged copy outside the archive and omit
      // both source and runtime-resource copies from the application bundle.
      files: [
        ...files,
        "!apps/desktop/resources/cua-driver/**",
        "!apps/desktop/prod-resources/cua-driver/**",
      ],
      extraResources: [{ from: "apps/desktop/resources/cua-driver", to: "cua-driver" }],
      linux: {
        target: [input.target],
        executableName: "synara",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "synara",
          },
        },
      },
    };
  }

  return {
    ...nativePackaging,
    // Keep the Windows product registration stable while the public app ID changes.
    // This lets NSIS updates replace the existing installation and own its uninstaller.
    nsis: {
      guid: input.flavor === "beta" ? WINDOWS_BETA_INSTALLER_GUID : WINDOWS_INSTALLER_GUID,
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions
        ? {
            publisherName: input.windowsAzureSignOptions.publisherName,
            azureSignOptions: input.windowsAzureSignOptions,
          }
        : {}),
    },
  };
}
