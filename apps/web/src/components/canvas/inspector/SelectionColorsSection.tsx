// FILE: SelectionColorsSection.tsx
// Purpose: Inspector Selection colors: every distinct colour painted inside
//          the selection, each editable in place. Editing one rewrites every place that colour
//          is set (fills, text, borders, outlines, decorations, text strokes and shadows) as
//          one undo step.
// Layer: Canvas editor UI

import type { DesignLayerEdit } from "@synara/contracts";
import { DESIGN_LAYER_ATTRIBUTE } from "@synara/shared/designCanvasLayers";
import { useState } from "react";
import { useTranslation } from "~/i18n";
import type { CanvasSelectionItem } from "../canvasStores";
import { selectionKey } from "../canvasStores";
import { ColorField } from "./ColorField";
import { InspectorSection } from "./InspectorControls";
import {
  formatBoxShadow,
  formatTextShadow,
  parseBoxShadow,
  sameColor,
  SIDES,
  toCssColor,
  type Rgba,
  type Shadow,
  type StylePatch,
} from "./inspectorValues";
import { frameRootOf } from "./StyleSections";
import { resolveCssColor, specifiedValues, type InspectorModel } from "./useInspectorModel";
import { Button } from "../../ui/button";

/** The first ten are listed, then the rest on request. */
const VISIBLE_COLORS = 10;
const MAX_ELEMENTS = 2000;

type ColorUse = {
  item: CanvasSelectionItem;
  /** A colour longhand, or a shadow list whose matching colours are replaced. */
  property: string;
  shadow?: "box-shadow" | "text-shadow";
  /** The shadow list as it was collected, so repeated previews start from the original. */
  shadows?: readonly Shadow[];
};
export type SelectionColor = { color: Rgba; uses: ColorUse[] };

/** Collects the distinct colours in the selected frames and layers, most used first. */
export function collectSelectionColors(model: InspectorModel): SelectionColor[] {
  const groups: SelectionColor[] = [];
  const seen = new Set<string>();
  const add = (value: string, use: ColorUse) => {
    const color = resolveCssColor(value);
    if (!color || color.a === 0) return;
    const key = `${selectionKey(use.item)}|${use.property}|${toCssColor(color)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const group = groups.find((item) => sameColor(item.color, color));
    if (group) group.uses.push(use);
    else groups.push({ color, uses: [use] });
  };
  let visited = 0;
  for (const target of model.targets) {
    const index = model.editor.layers(target.frame.id);
    const styleOf = (item: CanvasSelectionItem) => {
      if (item.kind === "frame") return target.frame.style;
      const node = index?.nodes.get(item.layerId);
      return node?.type === "element" ? node.attributes.style : undefined;
    };
    const itemOf = (element: Element): CanvasSelectionItem | null => {
      if (element === target.element) return target.item;
      const layerId = element.getAttribute(DESIGN_LAYER_ATTRIBUTE);
      return layerId ? { kind: "layer", frameId: target.frame.id, layerId } : null;
    };
    const declares = (element: Element, property: string) => {
      const item = itemOf(element);
      return item !== null && specifiedValues(styleOf(item))(property) !== "";
    };
    const elements = [
      target.element,
      ...target.element.querySelectorAll(`[${DESIGN_LAYER_ATTRIBUTE}]`),
    ];
    for (const element of elements) {
      if (++visited > MAX_ELEMENTS) break;
      const item = itemOf(element);
      if (!item) continue;
      const style = getComputedStyle(element);
      add(style.backgroundColor, { item, property: "background-color" });
      const ownText = [...element.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
      );
      if (ownText) {
        // Text colour is inherited: edit it where it is set inside the selection, or on the
        // selected layer when it comes from outside.
        let owner: Element = element;
        while (owner !== target.element && !declares(owner, "color") && owner.parentElement)
          owner = owner.parentElement;
        const ownerItem = itemOf(owner) ?? target.item;
        add(style.color, { item: ownerItem, property: "color" });
      } else if (element === target.element && target.svg?.currentColor)
        // An inline SVG painted with currentColor: its colour is the SVG's `color`.
        add(style.color, { item, property: "color" });
      for (const side of SIDES) {
        const width = parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
        const lineStyle = style.getPropertyValue(`border-${side}-style`);
        if (width > 0 && lineStyle !== "none" && lineStyle !== "hidden")
          add(style.getPropertyValue(`border-${side}-color`), {
            item,
            property: `border-${side}-color`,
          });
      }
      if (style.outlineStyle !== "none" && (parseFloat(style.outlineWidth) || 0) > 0)
        add(style.outlineColor, { item, property: "outline-color" });
      if (style.textDecorationLine !== "none" && declares(element, "text-decoration-color"))
        add(style.textDecorationColor, { item, property: "text-decoration-color" });
      const stroke = parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) || 0;
      if (stroke > 0 && declares(element, "-webkit-text-stroke-color"))
        add(style.getPropertyValue("-webkit-text-stroke-color"), {
          item,
          property: "-webkit-text-stroke-color",
        });
      const boxShadows = parseBoxShadow(style.boxShadow);
      for (const shadow of boxShadows)
        add(shadow.color, {
          item,
          property: "box-shadow",
          shadow: "box-shadow",
          shadows: boxShadows,
        });
      const textShadows = ownText ? parseBoxShadow(style.textShadow) : [];
      for (const shadow of textShadows)
        add(shadow.color, {
          item,
          property: "text-shadow",
          shadow: "text-shadow",
          shadows: textShadows,
        });
    }
  }
  return groups
    .map((group, order) => ({ group, order }))
    .toSorted((a, b) => b.group.uses.length - a.group.uses.length || a.order - b.order)
    .map(({ group }) => group);
}

/** The patches that repaint `from` as `to` wherever the group uses it, by layer. */
export function recolorPatches(
  group: SelectionColor,
  to: string,
): Map<string, { item: CanvasSelectionItem; patch: StylePatch }> {
  const patches = new Map<string, { item: CanvasSelectionItem; patch: StylePatch }>();
  for (const use of group.uses) {
    const key = selectionKey(use.item);
    const entry = patches.get(key) ?? { item: use.item, patch: {} };
    patches.set(key, entry);
    if (!use.shadow) {
      entry.patch[use.property] = to;
      continue;
    }
    const shadows = (use.shadows ?? []).map((shadow): Shadow => {
      const rgba = resolveCssColor(shadow.color);
      const color =
        rgba && sameColor(rgba, group.color) ? to : rgba ? toCssColor(rgba) : shadow.color;
      return {
        x: shadow.x,
        y: shadow.y,
        blur: shadow.blur,
        spread: shadow.spread,
        color,
        inset: shadow.inset,
      };
    });
    entry.patch[use.shadow] =
      use.shadow === "box-shadow" ? formatBoxShadow(shadows) : formatTextShadow(shadows);
  }
  return patches;
}

export function SelectionColorsSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  // Colours are read from the rendered DOM, which previews change: while one is being edited
  // the list stays as it was, so rows keep their place and their open picker.
  const [frozen, setFrozen] = useState<SelectionColor[] | null>(null);
  const colors = frozen ?? collectSelectionColors(model);
  if (colors.length === 0) return null;
  const shown = showAll ? colors : colors.slice(0, VISIBLE_COLORS);
  const { editor } = model;

  const preview = (group: SelectionColor, to: string) => {
    if (model.readOnly) return;
    if (!frozen) setFrozen(colors);
    for (const { item, patch } of recolorPatches(group, to).values())
      editor.previewStyles([item], patch);
  };
  const commit = async (group: SelectionColor, to: string) => {
    if (model.readOnly) return;
    const byFrame = new Map<string, DesignLayerEdit[]>();
    for (const { item, patch } of recolorPatches(group, to).values()) {
      const operations = byFrame.get(item.frameId) ?? [];
      byFrame.set(item.frameId, operations);
      operations.push(
        item.kind === "frame"
          ? { type: "set_frame_styles", styles: patch }
          : { type: "set_styles", nodeId: item.layerId, styles: patch },
      );
    }
    try {
      await editor.batch(async () => {
        for (const [frameId, operations] of byFrame)
          await editor.run({ kind: "edit", frameId, operations });
      });
    } finally {
      setFrozen(null);
    }
  };

  return (
    <InspectorSection title={t("workspace:canvasInspectorSelectionColors")}>
      <ul className="flex flex-col gap-1.5">
        {shown.map((group, index) => (
          // Rows are positional while one is edited (the list is frozen then).
          // oxlint-disable-next-line no-array-index-key
          <li key={index} className="min-w-0 list-none">
            <ColorField
              value={toCssColor(group.color)}
              ariaLabel={t("workspace:canvasInspectorSelectionColor", { number: index + 1 })}
              disabled={model.readOnly}
              frameRoot={frameRootOf(model)}
              onPreview={(next) => preview(group, next)}
              onCommit={(next) => void commit(group, next)}
            />
          </li>
        ))}
      </ul>
      {colors.length > VISIBLE_COLORS ? (
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t("workspace:canvasInspectorShowFewerColors")
            : t("workspace:canvasInspectorShowAllColors", { count: colors.length })}
        </Button>
      ) : null}
    </InspectorSection>
  );
}
