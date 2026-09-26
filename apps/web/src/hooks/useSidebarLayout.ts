// FILE: useSidebarLayout.ts
// Purpose: The single resolver for which app shell renders: classic sidebar or rail + panel.
// Layer: Web shell hook
// Exports: SidebarLayout, resolveSidebarLayout, useSidebarLayout

import { useAppSettings, type SidebarLayout } from "../appSettings";
import { isBetaFeatureOn } from "../betaFeatures";
import { useIsMobile } from "./useMediaQuery";

export type { SidebarLayout };

/**
 * The rail layout needs all three: the user chose it, the host is not Stable (the
 * Beta-only "sidebarV2" key), and the viewport is not mobile (the rail is a desktop
 * shell). Anything else is classic, which keeps a stored "rail" inert on Stable.
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
