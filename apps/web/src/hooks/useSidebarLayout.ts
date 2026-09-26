// FILE: useSidebarLayout.ts
// Purpose: The single resolver for which app shell renders: classic sidebar or rail + panel.
// Layer: Web shell hook
// Exports: SidebarLayout, resolveSidebarLayout, useSidebarLayout

import { useAppSettings, type SidebarLayout } from "../appSettings";
import { isBetaFeatureOn } from "../betaFeatures";
import { useIsMobile } from "./useMediaQuery";

export type { SidebarLayout };

/**
 * The rail layout requires the user preference, an enabled feature, and a desktop
 * viewport. It is available in both Stable and Beta; mobile stays classic.
 */
export function resolveSidebarLayout(input: {
  setting: SidebarLayout;
  betaFeatureOn: boolean;
  isMobile: boolean;
}): SidebarLayout {
  return input.setting === "rail" && input.betaFeatureOn && !input.isMobile ? "rail" : "classic";
}

/** Every shell consumer reads this hook; nobody re-derives the layout on its own. */
export function useSidebarLayout(): SidebarLayout {
  const { settings } = useAppSettings();
  const isMobile = useIsMobile();
  return resolveSidebarLayout({
    setting: settings.sidebarLayout,
    betaFeatureOn: isBetaFeatureOn("sidebarV2"),
    isMobile,
  });
}
