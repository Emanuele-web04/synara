import { useEffect } from "react";
import { useAppSettings } from "../appSettings";
import { isMacNavigatorPlatform } from "../lib/utils";

export function useNativeFontSmoothing() {
  const { settings } = useAppSettings();
  const shouldApply = settings.enableNativeFontSmoothing && isMacNavigatorPlatform();

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
