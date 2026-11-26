// FILE: PageSection.tsx
// Purpose: The inspector with nothing selected: the Page section with the page's canvas colour
//          (swatch, hex, opacity and the picker), saved on the page; resetting it goes back to
//          the theme's canvas colour.
// Layer: Canvas editor UI
// Exports: PageSection, pageColorOf, themeCanvasColor

import { useTranslation } from "~/i18n";
import { useCanvasEditor } from "../editor/CanvasEditorContext";
import { useCanvasPageActions } from "../useCanvasPageActions";
import { ColorField } from "./ColorField";
import { InspectorSection } from "./InspectorControls";
import { toCssColor } from "./inspectorValues";
import { resolveCssColor } from "./useInspectorModel";

const noop = () => {};

/** A picked CSS colour as a page stores it (`#rrggbb`, or `#rrggbbaa` when see-through). */
export function pageColorOf(css: string): string | null {
  const rgba = resolveCssColor(css);
  return rgba ? toCssColor(rgba).toLowerCase() : null;
}

/** The theme's canvas colour where the page sets none: the canvas backdrop, as a hex colour. */
export function themeCanvasColor(): string {
  if (typeof document === "undefined") return "#f2f2f2";
  // The backdrop is a `color-mix()` of app tokens; a probe resolves it to one colour.
  const probe = document.createElement("div");
  probe.style.backgroundColor = "var(--canvas-backdrop)";
  document.body.append(probe);
  const color = pageColorOf(getComputedStyle(probe).backgroundColor);
  probe.remove();
  return color ?? "#f2f2f2";
}

/** The canvas element of this editor, for a live preview of the colour being picked. */
function viewports(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-canvas-viewport]")];
}

export function PageSection() {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const { page, work } = editor;
  const actions = useCanvasPageActions(work, page.id, editor.selectPage ?? noop);
  const disabled = actions.readOnly;
  const preview = (color: string | null) => {
    for (const viewport of viewports())
      if (viewport.dataset.canvasPage === page.id) viewport.style.backgroundColor = color ?? "";
  };
  const save = (color: string | null) => {
    preview(color);
    void actions.setColor(page.id, color).finally(() => preview(null));
  };
  return (
    <InspectorSection title={t("workspace:canvasInspectorPage")}>
      <ColorField
        value={page.color ?? themeCanvasColor()}
        ariaLabel={t("workspace:canvasInspectorPageColor")}
        disabled={disabled}
        onPreview={(color) => preview(color)}
        onCommit={(color) => {
          const next = pageColorOf(color);
          if (next && next !== page.color) save(next);
        }}
        removeLabel={page.color ? t("workspace:canvasInspectorPageColorReset") : undefined}
        onRemove={page.color ? () => save(null) : undefined}
      />
    </InspectorSection>
  );
}
