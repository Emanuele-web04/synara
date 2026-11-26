// FILE: canvasPageIcons.tsx
// Purpose: The page list's icons: each CanvasPageIcon key drawn with one of Synara's Central
//          icons, its label, and the glyph a page row shows (the default page icon when unset or
//          when a newer client stored a key this one does not know).
// Layer: Canvas UI
// Exports: CANVAS_PAGE_ICON_OPTIONS, CanvasPageGlyph

import { CANVAS_PAGE_ICONS, type CanvasPageIcon } from "@synara/contracts";
import { CentralIcon } from "~/lib/central-icons";
import { FileIcon } from "~/lib/icons";

/** Central icon basenames (`public/central-icons-reversed`) for each page icon key. */
const CENTRAL_NAMES: Record<CanvasPageIcon, string> = {
  pen: "pencil-line",
  bezier: "bezier",
  image: "images-1",
  table: "table",
  slides: "slides-wide",
  plan: "plan",
  swatch: "color-swatch",
  "bar-chart": "chart-2",
  "line-chart": "line-chart-1",
  "pie-chart": "pie-chart-1",
  phone: "phone",
  dashboard: "layout-dashboard",
  components: "components",
  sparkle: "sparkle",
  archive: "archive",
};

const LABEL_KEYS: Record<CanvasPageIcon, string> = {
  pen: "workspace:canvasPageIconPen",
  bezier: "workspace:canvasPageIconBezier",
  image: "workspace:canvasPageIconImage",
  table: "workspace:canvasPageIconTable",
  slides: "workspace:canvasPageIconSlides",
  plan: "workspace:canvasPageIconPlan",
  swatch: "workspace:canvasPageIconSwatch",
  "bar-chart": "workspace:canvasPageIconBarChart",
  "line-chart": "workspace:canvasPageIconLineChart",
  "pie-chart": "workspace:canvasPageIconPieChart",
  phone: "workspace:canvasPageIconPhone",
  dashboard: "workspace:canvasPageIconDashboard",
  components: "workspace:canvasPageIconComponents",
  sparkle: "workspace:canvasPageIconSparkle",
  archive: "workspace:canvasPageIconArchive",
};

/** The icons the Page icon menu offers, in order, with their Central name and label key. */
export const CANVAS_PAGE_ICON_OPTIONS = CANVAS_PAGE_ICONS.map((icon) => ({
  icon,
  centralName: CENTRAL_NAMES[icon],
  labelKey: LABEL_KEYS[icon],
}));

const centralNameOf = (icon: string | undefined) =>
  icon && Object.hasOwn(CENTRAL_NAMES, icon) ? CENTRAL_NAMES[icon as CanvasPageIcon] : null;

/** A page's icon in the page lists. */
export function CanvasPageGlyph({
  icon,
  className,
}: {
  icon: string | undefined;
  className?: string | undefined;
}) {
  const name = centralNameOf(icon);
  return name ? (
    <CentralIcon name={name} className={className} data-canvas-page-icon={icon} />
  ) : (
    <FileIcon className={className} />
  );
}
