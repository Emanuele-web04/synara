import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";

export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  // Icon Composer source for the macOS 26 bundle icon. Only a layered ".icon"
  // asset gets the Liquid Glass material; a flat ICNS/PNG never does.
  productionMacIconComposer: "assets/prod/Synara.icon",
  productionMacLegacyIconPng: "assets/prod/black-macos-legacy-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/synara-black-windows.ico",
  productionWebFaviconIco: "assets/prod/synara-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/synara-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/synara-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/synara-black-web-apple-touch-180.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export const BETA_ASSET_PATHS = {
  betaMacIconPng: "assets/beta/beta-macos-1024.png",
  // Icon Composer source for the beta macOS 26 bundle icon: same layered
  // treatment as production so beta gets Liquid Glass on the dock.
  betaMacIconComposer: "assets/beta/Synara.icon",
  betaMacLegacyIconPng: "assets/beta/beta-macos-legacy-1024.png",
  // One artwork serves both appearances: the dark dock slot reuses the rounded legacy file.
  betaMacLegacyDarkIconPng: "assets/beta/beta-macos-legacy-1024.png",
  betaLinuxIconPng: "assets/beta/beta-universal-1024.png",
  betaWindowsIconIco: "assets/beta/beta-windows.ico",
  betaWebFaviconIco: "assets/beta/beta-web-favicon.ico",
  betaWebFavicon16Png: "assets/beta/beta-web-favicon-16x16.png",
  betaWebFavicon32Png: "assets/beta/beta-web-favicon-32x32.png",
  betaWebAppleTouchIconPng: "assets/beta/beta-web-apple-touch-180.png",
} as const;

export type DesktopBuildFlavor = SynaraPackagedDesktopFlavor;

export interface DesktopIconAssetPaths {
  readonly macIconPng: string;
  readonly macIconComposer: string;
  readonly macLegacyIconPng: string;
  /** Dark-appearance dock icon; absent flavors keep their inherited resource. */
  readonly macLegacyDarkIconPng?: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

/** Beta builds carry their own vivid-blue + white BETA pill brand; every other flavor keeps production. */
export function desktopIconAssetPaths(flavor: DesktopBuildFlavor): DesktopIconAssetPaths {
  if (flavor === "beta") {
    return {
      macIconPng: BETA_ASSET_PATHS.betaMacIconPng,
      macIconComposer: BETA_ASSET_PATHS.betaMacIconComposer,
      macLegacyIconPng: BETA_ASSET_PATHS.betaMacLegacyIconPng,
      macLegacyDarkIconPng: BETA_ASSET_PATHS.betaMacLegacyDarkIconPng,
      linuxIconPng: BETA_ASSET_PATHS.betaLinuxIconPng,
      windowsIconIco: BETA_ASSET_PATHS.betaWindowsIconIco,
    };
  }
  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    macIconComposer: BRAND_ASSET_PATHS.productionMacIconComposer,
    macLegacyIconPng: BRAND_ASSET_PATHS.productionMacLegacyIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const DEVELOPMENT_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

const BETA_PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BETA_ASSET_PATHS.betaWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BETA_ASSET_PATHS.betaWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BETA_ASSET_PATHS.betaWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BETA_ASSET_PATHS.betaWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

/** Favicon overrides for a packaged build; beta ships its own vivid-blue set. */
export function publishIconOverrides(flavor: DesktopBuildFlavor): ReadonlyArray<IconOverride> {
  return flavor === "beta" ? BETA_PUBLISH_ICON_OVERRIDES : PUBLISH_ICON_OVERRIDES;
}
