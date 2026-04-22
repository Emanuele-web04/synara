// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

export const MICROPHONE_USAGE_DESCRIPTION =
  "DP Code needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
const MAC_AFTER_PACK_HOOK_PATH = "./electron-builder-after-pack.cjs";
const MAC_DMG_ICON_PATH = "icon.icns";

export interface DesktopPlatformBuildConfig {
  readonly afterPack?: string;
  readonly dmg?: {
    readonly icon: string;
  };
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly hasMacIconComposer: boolean;
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  if (input.platform === "mac") {
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: input.hasMacIconComposer ? "icon.icon" : MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
        ...(input.hasMacIconComposer ? { CFBundleIconFile: MAC_DMG_ICON_PATH } : {}),
      },
    } satisfies Record<string, unknown>;

    if (!input.hasMacIconComposer) {
      return { mac };
    }

    return {
      mac,
      afterPack: MAC_AFTER_PACK_HOOK_PATH,
      dmg: {
        icon: MAC_DMG_ICON_PATH,
      },
    };
  }

  if (input.platform === "linux") {
    return {
      linux: {
        target: [input.target],
        executableName: "dpcode",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "dpcode",
          },
        },
      },
    };
  }

  return {
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions
        ? { azureSignOptions: input.windowsAzureSignOptions }
        : {}),
    },
  };
}
