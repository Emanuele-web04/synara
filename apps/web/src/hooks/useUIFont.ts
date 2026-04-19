// FILE: useUIFont.ts
// Purpose: Applies the optional UI-font override without stomping the active theme's base font.
// Layer: Web appearance override hook
// Exports: useUIFont

import { useEffect } from "react";
import { useAppSettings } from "../appSettings";

const UI_FONT_OVERRIDE_VARIABLE = "--app-font-ui-override";

export function useUIFont() {
  const { settings } = useAppSettings();
  const uiFontFamily = settings.uiFontFamily;

  useEffect(() => {
    if (uiFontFamily.trim()) {
      document.documentElement.style.setProperty(UI_FONT_OVERRIDE_VARIABLE, uiFontFamily.trim());
    } else {
      document.documentElement.style.removeProperty(UI_FONT_OVERRIDE_VARIABLE);
    }
  }, [uiFontFamily]);
}
