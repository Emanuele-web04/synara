// FILE: CanvasInspector.tsx
// Purpose: Right-side design inspector for the canvas editor. Shows the property sections for
//          the selected frames and layers (or the Page section with nothing selected) under its
//          top row, in this order: Layout (with Flex), Radius, Blending, Fill, SVG (an inline
//          SVG's colour), Text, Underline, Outline, Text stroke, Border, Shadow, Inner shadow,
//          Filters, Other styles, Selection colors and Export. Values are computed; edits write
//          inline CSS.
// Layer: Canvas editor UI
// Exports: CanvasInspector
// Depends on: CanvasEditorContext (must render inside CanvasEditorProvider).

import type { ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { FrameToolIcon, ImageIcon, TextToolIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ScrollArea } from "../../ui/scroll-area";
import { selectionKey } from "../canvasStores";
import { canvasTextSession, INSPECTOR_ROOT_ATTRIBUTE } from "../editor/canvasTextSession";
import { SvgLayerIcon } from "../editor/CanvasLayersPanel";
import { FiltersSection, InnerShadowSection, ShadowSection } from "./EffectSections";
import { ExportSection } from "./ExportSection";
import { FillSection } from "./FillSection";
import { LayoutSection } from "./LayoutSection";
import { PageSection } from "./PageSection";
import { SelectionColorsSection } from "./SelectionColorsSection";
import {
  BlendingSection,
  BorderSection,
  OtherStylesSection,
  OutlineSection,
  RadiusSection,
  SvgSection,
} from "./StyleSections";
import { TextSection, TextStrokeSection, UnderlineSection } from "./TextSection";
import { selectionKind, selectionName, useInspectorModel } from "./useInspectorModel";

/** The same glyphs as the layers panel rows. */
const KIND_ICONS = {
  frame: FrameToolIcon,
  container: FrameToolIcon,
  image: ImageIcon,
  text: TextToolIcon,
  svg: SvgLayerIcon,
} as const;

/**
 * Marks the inspector, and presses inside it (React delivers its portaled popups' presses here
 * too): a text edit stays open while the inspector styles its range.
 */
const inspectorRoot = {
  [INSPECTOR_ROOT_ATTRIBUTE]: "",
  onPointerDownCapture: (event: React.PointerEvent) =>
    canvasTextSession.notePress(event.nativeEvent),
};

/**
 * The inspector column. Its 48px top row names what is selected on the left and holds
 * `actions` (the zoom menu, the work's own buttons) on the right. With nothing selected it shows
 * the Page section (the page's canvas colour).
 */
export function CanvasInspector({
  className,
  actions,
}: {
  className?: string;
  /** Controls at the end of the top row (zoom menu, Back to chat, the work menu). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const model = useInspectorModel();
  const kind = model.targets.length > 0 ? selectionKind(model) : null;
  const Icon = kind ? KIND_ICONS[kind.kind] : null;
  const name =
    model.targets.length === 0
      ? null
      : (selectionName(model) ??
        t("workspace:canvasInspectorSelectedCount", { count: model.targets.length }));
  // The side pane's slim column has its zoom in the pane header: with nothing to show the row
  // is left out rather than kept empty.
  const topRow =
    !actions && !name && !model.readOnly ? null : (
      <div
        data-canvas-inspector-top=""
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border ps-3 pe-3"
      >
        {/* With the work's controls in the row, the selection is named in the layers panel
          already, so only the side pane names it here. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm text-muted-foreground">
          {actions ? null : (
            <>
              {Icon ? (
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              {name ? <span className="min-w-0 truncate">{name}</span> : null}
              {kind?.tag ? (
                <span className="shrink-0 text-muted-foreground/72">{kind.tag}</span>
              ) : null}
            </>
          )}
        </div>
        {model.readOnly ? (
          <span className="shrink-0 text-ui-sm text-muted-foreground">
            {t("workspace:canvasInspectorReadOnly")}
          </span>
        ) : null}
        {actions}
      </div>
    );
  if (model.targets.length === 0)
    return (
      <div
        {...inspectorRoot}
        role="region"
        aria-label={t("workspace:canvasInspector")}
        className={cn("flex min-h-0 flex-col text-foreground", className)}
      >
        {topRow}
        <PageSection />
      </div>
    );
  // Remount per selection so expanded rows and drafts never leak to the next selection.
  const selection = model.targets.map((target) => selectionKey(target.item)).join(",");
  return (
    <div
      {...inspectorRoot}
      role="region"
      aria-label={t("workspace:canvasInspector")}
      className={cn("flex min-h-0 flex-col text-foreground", className)}
    >
      {topRow}
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div key={selection} className="flex flex-col pb-3">
          <LayoutSection model={model} />
          <RadiusSection model={model} />
          <BlendingSection model={model} />
          <FillSection model={model} />
          <SvgSection model={model} />
          <TextSection model={model} />
          <UnderlineSection model={model} />
          <OutlineSection model={model} />
          <TextStrokeSection model={model} />
          <BorderSection model={model} />
          <ShadowSection model={model} />
          <InnerShadowSection model={model} />
          <FiltersSection model={model} />
          <OtherStylesSection model={model} />
          <SelectionColorsSection model={model} />
          <ExportSection model={model} />
        </div>
      </ScrollArea>
    </div>
  );
}
