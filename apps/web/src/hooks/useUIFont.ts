import { useEffect } from "react";
import { useAppSettings } from "../appSettings";

export function useUIFont() {
  const { settings } = useAppSettings();
  const uiFontFamily = settings.uiFontFamily;

  useEffect(() => {
    if (uiFontFamily.trim()) {
      document.documentElement.style.setProperty("--font-ui-family", uiFontFamily.trim());
    } else {
      document.documentElement.style.removeProperty("--font-ui-family");
    }
  }, [uiFontFamily]);
}
