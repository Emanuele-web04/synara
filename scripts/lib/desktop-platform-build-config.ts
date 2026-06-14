// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
const MAC_AFTER_PACK_HOOK_PATH = "./electron-builder-after-pack.cjs";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;
export const WANDY_ASAR_UNPACK_GLOBS = ["node_modules/@t3tools/wandy/**"] as const;
export const DESKTOP_NATIVE_ASAR_UNPACK_GLOBS = [
  ...NODE_PTY_ASAR_UNPACK_GLOBS,
  ...WANDY_ASAR_UNPACK_GLOBS,
] as const;

export interface DesktopPlatformBuildConfig {
  readonly afterPack?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
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

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
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
  const nativePackaging = { asarUnpack: [...DESKTOP_NATIVE_ASAR_UNPACK_GLOBS] };

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
      return { ...nativePackaging, mac };
    }

    return {
      ...nativePackaging,
      mac,
      afterPack: MAC_AFTER_PACK_HOOK_PATH,
      dmg: {
        icon: MAC_DMG_ICON_PATH,
      },
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
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
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions ? { azureSignOptions: input.windowsAzureSignOptions } : {}),
    },
  };
}
