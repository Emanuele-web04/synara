// FILE: ActivityHeatmap.tsx
// Purpose: Keep the shared heatmap's dates and tooltip copy in the web app's active locale.
// Layer: web profile presentation; layout and rendering stay in profile-ui.

import type { ComponentProps } from "react";
import {
  ActivityHeatmap as SharedActivityHeatmap,
  type HeatmapCell,
} from "@synara/profile-ui/heatmap";
import { getFormatLocale, t, useTranslation } from "~/i18n";
import { formatCompact, formatShortDate } from "./profileFormatting";

export {
  APP_HEATMAP_INTENSITY_CLASSES,
  CARD_HEATMAP_INTENSITY_CLASSES,
} from "@synara/profile-ui/heatmap";

export function ActivityHeatmap(props: ComponentProps<typeof SharedActivityHeatmap>) {
  const { formatLocale } = useTranslation();
  return <SharedActivityHeatmap {...props} formatLocale={formatLocale} />;
}

// Translate the web tooltip without importing web localization into the shared package.
export function heatmapTooltipText(
  cell: HeatmapCell,
  unit: string,
  formatLocale = getFormatLocale(),
): string {
  const date = formatShortDate(cell.day, formatLocale) ?? cell.day;
  if (cell.count <= 0) {
    return t("common:noOn", {
      value0:
        unit === "prompts" || unit === "tokens"
          ? t(unit === "prompts" ? "common:profile_prompts" : "chat:tokens")
          : unit,
      value1: date,
    });
  }
  const noun = cell.count === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return t("common:on", {
    value0: formatCompact(cell.count, formatLocale),
    value1:
      unit === "prompts" || unit === "tokens"
        ? t(
            unit === "prompts"
              ? cell.count === 1
                ? "chat:profile_prompt"
                : "common:profile_prompts"
              : cell.count === 1
                ? "common:tokenSingular"
                : "chat:tokens",
          )
        : noun,
    value2: date,
  });
}
