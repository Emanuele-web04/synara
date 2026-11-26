// FILE: useInlineVisualTheme.ts
// Purpose: The app theme and chat font size, as CSS variables handed to inline visuals.
// Layer: Web hook (consumed by InlineVisualFrame)
// Exports: useInlineVisualTheme

import { INLINE_VISUAL_SERIES_COLORS, type InlineVisualTheme } from "@synara/shared/inlineVisual";
import { useLayoutEffect, useState } from "react";

import { useAppSettings } from "../appSettings";
import { getAppTypographyScale } from "../lib/appTypography";
import { useTheme } from "./useTheme";

// App tokens a visual may style against, under the same names (index.css).
const SHARED_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--info",
  "--info-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--radius",
] as const;

function readInlineVisualTheme(
  appearance: InlineVisualTheme["appearance"],
  chatFontSizePx: number,
): InlineVisualTheme {
  const variables: Record<string, string> = {};
  const computed =
    typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  if (computed) {
    for (const name of SHARED_THEME_VARIABLES) {
      const value = computed.getPropertyValue(name).trim();
      if (value) variables[name] = value;
    }
    const sans = computed.getPropertyValue("--font-ui-family").trim();
    const mono = computed.getPropertyValue("--font-mono-family").trim();
    if (sans) variables["--font-sans"] = sans;
    if (mono) variables["--font-mono"] = mono;
  }
  // From the setting itself: the root size variables are applied in an effect
  // that may not have run yet when this reads.
  variables["--font-size"] = `${getAppTypographyScale(chatFontSizePx).chatPx}px`;
  // Series 1 is the theme accent, derived inside the page.
  INLINE_VISUAL_SERIES_COLORS[appearance].forEach((color, index) => {
    variables[`--series-${index + 2}`] = color;
  });
  return { appearance, variables };
}

function sameTheme(left: InlineVisualTheme, right: InlineVisualTheme): boolean {
  if (left.appearance !== right.appearance) return false;
  const leftNames = Object.keys(left.variables);
  return (
    leftNames.length === Object.keys(right.variables).length &&
    leftNames.every((name) => left.variables[name] === right.variables[name])
  );
}

/**
 * The theme a visual is built with and later follows. Stable until a value
 * changes, so posting it to mounted frames happens only on a real change.
 */
export function useInlineVisualTheme(): InlineVisualTheme {
  const { resolvedTheme, activeTheme } = useTheme();
  const { settings } = useAppSettings();
  const chatFontSizePx = settings.chatFontSizePx;
  const [theme, setTheme] = useState(() => readInlineVisualTheme(resolvedTheme, chatFontSizePx));
  // `activeTheme` is a dependency on purpose: editing a custom theme changes
  // the root variables without changing the light/dark appearance.
  useLayoutEffect(() => {
    const next = readInlineVisualTheme(resolvedTheme, chatFontSizePx);
    setTheme((previous) => (sameTheme(previous, next) ? previous : next));
  }, [activeTheme, resolvedTheme, chatFontSizePx]);
  return theme;
}
