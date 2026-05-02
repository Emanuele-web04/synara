// FILE: useNativeFontSmoothing.ts
// Purpose: Applies the optional platform font-smoothing preference to the app root.
// Layer: Web appearance override hook
// Exports: useNativeFontSmoothing

import { useEffect } from "react";
import { useAppSettings } from "../appSettings";
import { isMacPlatform } from "../lib/utils";

export function useNativeFontSmoothing() {
  const { settings } = useAppSettings();
  const shouldApply =
    settings.enableNativeFontSmoothing &&
    isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    if (shouldApply) {
      rootStyle.setProperty("-webkit-font-smoothing", "antialiased");
      rootStyle.setProperty("-moz-osx-font-smoothing", "grayscale");
    } else {
      rootStyle.removeProperty("-webkit-font-smoothing");
      rootStyle.removeProperty("-moz-osx-font-smoothing");
    }
  }, [shouldApply]);
}
