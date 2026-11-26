// FILE: CanvasInspector.tsx
// Purpose: Right-side design inspector for the canvas editor. Shows the property sections for
//          the selected frames and layers (or the Page section with nothing selected) from the
//          top of the column, in this order: Layout (with Flex), Radius, Blending, Fill, SVG (an inline
//          SVG's colour), Text, Underline, Outline, Text stroke, Border, Shadow, Inner shadow,
//          Filters, Other styles, Selection colors and Export. Values are computed; edits write
//          inline CSS.
// Layer: Canvas editor UI
// Exports: CanvasInspector
// Depends on: CanvasEditorContext (must render inside CanvasEditorProvider).

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
 * The inspector column: the property sections, starting at the top of the column. With nothing
 * selected it shows the Page section (the page's canvas colour). `selectionRow` adds a 40px row
 * naming what is selected (the side pane, which has no layers panel to name it); a read-only
 * work gets the row in either case, to say why nothing can be edited.
 */
export function CanvasInspector({
  className,
  selectionRow = false,
}: {
  className?: string;
  selectionRow?: boolean;
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
  const named = selectionRow && name !== null;
  const topRow =
    !named && !model.readOnly ? null : (
      <div
        data-canvas-inspector-top=""
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm text-muted-foreground">
          {named ? (
            <>
              {Icon ? (
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="min-w-0 truncate text-foreground">{name}</span>
              {kind?.tag ? (
                <span className="shrink-0 text-muted-foreground/72">{kind.tag}</span>
              ) : null}
            </>
          ) : null}
        </div>
        {model.readOnly ? (
          <span className="shrink-0 text-ui-sm text-muted-foreground">
            {t("workspace:canvasInspectorReadOnly")}
          </span>
        ) : null}
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
