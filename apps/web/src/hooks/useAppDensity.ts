import { useEffect } from "react";

import {
  normalizeUiDensity,
  getDensityCssVariables,
  type DensityCssVariable,
} from "../lib/appDensity";
import { useAppSettings } from "../appSettings";

const DENSITY_CSS_VARIABLES = Object.keys(
  getDensityCssVariables(),
) as readonly DensityCssVariable[];

export function useAppDensity() {
  const { settings } = useAppSettings();
  const uiDensity = normalizeUiDensity(settings.uiDensity);

  useEffect(() => {
    const root = document.documentElement;
    const rootStyle = root.style;
    const variableValues = getDensityCssVariables(uiDensity);

    for (const cssVariable of DENSITY_CSS_VARIABLES) {
      rootStyle.setProperty(cssVariable, variableValues[cssVariable]);
    }
    root.dataset.uiDensity = uiDensity;

    return () => {
      for (const cssVariable of DENSITY_CSS_VARIABLES) {
        rootStyle.removeProperty(cssVariable);
      }
      delete root.dataset.uiDensity;
    };
  }, [uiDensity]);
}
