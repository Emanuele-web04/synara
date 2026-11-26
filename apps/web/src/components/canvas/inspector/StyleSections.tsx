// FILE: StyleSections.tsx
// Purpose: Inspector Radius, Blending, SVG, Outline, Border and Other styles sections.
// Layer: Canvas editor UI

import { useState } from "react";
import { useTranslation } from "~/i18n";
import { XIcon } from "~/lib/icons";
import { IconButton } from "../../ui/icon-button";
import { ColorField } from "./ColorField";
import {
  InspectorExpand,
  InspectorIcon,
  InspectorMixedRow,
  InspectorNumberField,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  InspectorToggle,
} from "./InspectorControls";
import {
  borderSides,
  borderWidthPatch,
  CORNERS,
  formatLength,
  formatNumber,
  isHandledProperty,
  isMixed,
  MIXED as MIXED_VALUE,
  mergeValues,
  mixedNumber,
  SIDES,
  single,
  toCssColor,
  type CssInput,
  type Side,
  type StylePatch,
} from "./inspectorValues";
import { resolveCssColor, type InspectorModel, type InspectorTarget } from "./useInspectorModel";

const pxOf = (value: string) => parseFloat(value) || 0;
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

/** Length text for a typed value; keywords other than none/auto are ignored. */
function lengthOrNull(input: CssInput): string | null | undefined {
  if (input.kind === "length") return formatLength(Math.max(0, input.value), input.unit);
  return input.keyword === "none" || input.keyword === "auto" ? null : undefined;
}

/** The swatches in the color popover come from the first selected frame. */
export function frameRootOf(model: InspectorModel) {
  const first = model.targets[0];
  return () => (first ? model.editor.elementFor({ kind: "frame", frameId: first.frame.id }) : null);
}

// ── Radius ───────────────────────────────────────────────────────────────

const CORNER_ICON_ROTATION = {
  "top-left": "",
  "top-right": "rotate-90",
  "bottom-right": "rotate-180",
  "bottom-left": "-rotate-90",
} as const;

export function RadiusSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const corners = (target: InspectorTarget) =>
    CORNERS.map((corner) => pxOf(target.computed[`border-${corner}-radius`]));
  const uniform = (target: InspectorTarget) => {
    const values = corners(target);
    return values.every((value) => value === values[0]) ? values[0]! : Number.NaN;
  };
  const [individual, setIndividual] = useState(() =>
    model.targets.some((target) => Number.isNaN(uniform(target))),
  );
  const resetCorners = Object.fromEntries(
    CORNERS.map((corner) => [`border-${corner}-radius`, null]),
  ) as StylePatch;
  const cornerLabels = {
    "top-left": t("workspace:canvasInspectorRadiusTopLeft"),
    "top-right": t("workspace:canvasInspectorRadiusTopRight"),
    "bottom-right": t("workspace:canvasInspectorRadiusBottomRight"),
    "bottom-left": t("workspace:canvasInspectorRadiusBottomLeft"),
  };
  const cornerField = (corner: (typeof CORNERS)[number], index: number) => (
    <InspectorNumberField
      key={corner}
      label={<InspectorIcon name="corner-radius" className={CORNER_ICON_ROTATION[corner]} />}
      ariaLabel={cornerLabels[corner]}
      {...mixedNumber(model.value((target) => corners(target)[index]!))}
      min={0}
      disabled={model.readOnly}
      onPreview={(value) => model.preview({ [`border-${corner}-radius`]: `${value}px` })}
      onCommit={(input) => {
        const value = lengthOrNull(input);
        if (value !== undefined) void model.commit({ [`border-${corner}-radius`]: value });
      }}
    />
  );
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorRadius")}
      headerAction={
        <InspectorToggle
          label={t("workspace:canvasInspectorIndividualCorners")}
          pressed={individual}
          onPressedChange={setIndividual}
        >
          <InspectorIcon name="square-placeholder-dashed" />
        </InspectorToggle>
      }
    >
      <div className="flex flex-col">
        <InspectorRow>
          <InspectorNumberField
            label={<InspectorIcon name="corner-radius" />}
            ariaLabel={t("workspace:canvasInspectorRadius")}
            {...mixedNumber(model.value(uniform))}
            min={0}
            disabled={model.readOnly}
            onPreview={(value) => model.preview({ ...resetCorners, "border-radius": `${value}px` })}
            onCommit={(input) => {
              const value = lengthOrNull(input);
              if (value !== undefined)
                void model.commit({ ...resetCorners, "border-radius": value });
            }}
          />
        </InspectorRow>
        <InspectorExpand open={individual}>
          <InspectorRow>
            {cornerField("top-left", 0)}
            {cornerField("top-right", 1)}
          </InspectorRow>
          <InspectorRow>
            {cornerField("bottom-left", 3)}
            {cornerField("bottom-right", 2)}
          </InspectorRow>
        </InspectorExpand>
      </div>
    </InspectorSection>
  );
}

// ── Blending ─────────────────────────────────────────────────────────────

export const BLEND_MODES = [
  ["normal", "workspace:canvasInspectorBlendNormal"],
  ["darken", "workspace:canvasInspectorBlendDarken"],
  ["multiply", "workspace:canvasInspectorBlendMultiply"],
  ["color-burn", "workspace:canvasInspectorBlendColorBurn"],
  ["lighten", "workspace:canvasInspectorBlendLighten"],
  ["screen", "workspace:canvasInspectorBlendScreen"],
  ["plus-lighter", "workspace:canvasInspectorBlendPlusLighter"],
  ["color-dodge", "workspace:canvasInspectorBlendColorDodge"],
  ["overlay", "workspace:canvasInspectorBlendOverlay"],
  ["soft-light", "workspace:canvasInspectorBlendSoftLight"],
  ["hard-light", "workspace:canvasInspectorBlendHardLight"],
  ["difference", "workspace:canvasInspectorBlendDifference"],
  ["exclusion", "workspace:canvasInspectorBlendExclusion"],
  ["hue", "workspace:canvasInspectorBlendHue"],
  ["saturation", "workspace:canvasInspectorBlendSaturation"],
  ["color", "workspace:canvasInspectorBlendColor"],
  ["luminosity", "workspace:canvasInspectorBlendLuminosity"],
] as const;

export function BlendingSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const opacity = mixedNumber(
    model.value((target) => Math.round((Number(target.computed.opacity) || 0) * 100)),
  );
  const blend = model.value((target) => target.computed["mix-blend-mode"]);
  const opacityValue = (percent: number) =>
    percent >= 100 ? null : formatNumber(Math.max(0, percent) / 100, 3);
  return (
    <InspectorSection title={t("workspace:canvasInspectorBlending")}>
      <InspectorRow>
        <InspectorNumberField
          ariaLabel={t("workspace:canvasInspectorOpacity")}
          suffix="%"
          unit="%"
          {...opacity}
          min={0}
          max={100}
          disabled={model.readOnly}
          onPreview={(value) => model.preview({ opacity: opacityValue(value) })}
          onCommit={(input) => {
            if (input.kind === "length")
              void model.commit({ opacity: opacityValue(Math.min(100, input.value)) });
          }}
        />
        <InspectorSelect
          ariaLabel={t("workspace:canvasInspectorBlendMode")}
          value={single(blend)}
          mixed={isMixed(blend)}
          disabled={model.readOnly}
          options={BLEND_MODES.map(([value, key]) => ({ value, label: t(key) }))}
          onChange={(next) =>
            void model.commit({ "mix-blend-mode": next === "normal" ? null : next })
          }
        />
      </InspectorRow>
    </InspectorSection>
  );
}

// ── SVG ──────────────────────────────────────────────────────────────────

/**
 * An inline SVG painted with `currentColor` takes its colour from its `color` (the icon's
 * colour). Shown only for such SVGs; an SVG with
 * fixed fills keeps them, and its box still has Fill, Border and the other box sections.
 */
export function SvgSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const targets = model.targets.filter((target) => target.svg?.currentColor);
  if (targets.length === 0) return null;
  const color = mergeValues(targets.map((target) => target.computed.color));
  const declared = targets.some((target) => target.declared.has("color"));
  return (
    <InspectorSection title={t("workspace:canvasInspectorSvg")}>
      <ColorField
        value={color ?? null}
        ariaLabel={t("workspace:canvasInspectorColor")}
        disabled={model.readOnly}
        frameRoot={frameRootOf(model)}
        onPreview={(next) => model.preview({ color: next }, targets)}
        onCommit={(next) => void model.commit({ color: next }, targets)}
        removeLabel={t("workspace:canvasInspectorRemove", {
          name: t("workspace:canvasInspectorColor"),
        })}
        onRemove={declared ? () => void model.commit({ color: null }, targets) : undefined}
      />
    </InspectorSection>
  );
}

// ── Border ───────────────────────────────────────────────────────────────

const BORDER_RESET: StylePatch = {
  border: null,
  "border-width": null,
  "border-style": null,
  "border-color": null,
  ...Object.fromEntries(
    SIDES.flatMap((side) => [
      [`border-${side}`, null],
      [`border-${side}-width`, null],
      [`border-${side}-style`, null],
      [`border-${side}-color`, null],
    ]),
  ),
};

const borderWidths = (target: InspectorTarget) =>
  Object.fromEntries(
    SIDES.map((side) => [side, pxOf(target.computed[`border-${side}-width`])]),
  ) as Record<Side, number>;
/** The first side that draws a border; its width, style and color stand for the border. */
const activeSide = (target: InspectorTarget): Side => {
  const widths = borderWidths(target);
  return SIDES.find((side) => widths[side] > 0) ?? "top";
};

/** Every border longhand of a target as computed, compared across nodes. */
const borderLonghands = (target: InspectorTarget): StylePatch =>
  Object.fromEntries(
    SIDES.flatMap((side) => {
      const width = pxOf(target.computed[`border-${side}-width`]);
      const color = resolveCssColor(target.computed[`border-${side}-color`]) ?? TRANSPARENT;
      return [
        [`border-${side}-width`, `${formatNumber(width)}px`],
        [`border-${side}-style`, width > 0 ? target.computed[`border-${side}-style`] : "none"],
        [`border-${side}-color`, toCssColor(color)],
      ];
    }),
  );

export function BorderSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const sidesOf = (target: InspectorTarget) => borderSides(borderWidths(target));
  const empty = model.targets.every((target) => sidesOf(target) === "none");
  const mixedList =
    mergeValues(model.targets.map((target) => JSON.stringify(borderLonghands(target)))) ===
    MIXED_VALUE;
  const width = mixedNumber(model.value((target) => borderWidths(target)[activeSide(target)]));
  const style = model.value((target) => target.computed[`border-${activeSide(target)}-style`]);
  const color = model.value((target) =>
    toCssColor(
      resolveCssColor(target.computed[`border-${activeSide(target)}-color`]) ?? TRANSPARENT,
    ),
  );
  const sides = model.value(sidesOf);
  const sideValue = single(sides);
  const nulls = (suffix: "style" | "color") =>
    Object.fromEntries(SIDES.map((side) => [`border-${side}-${suffix}`, null]));
  const addBorder = () =>
    void model.commit({
      ...BORDER_RESET,
      "border-width": "1px",
      "border-style": "solid",
      "border-color": "#000000",
    });
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorBorder")}
      empty={empty}
      disabled={model.readOnly}
      onAdd={addBorder}
    >
      {mixedList ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedBorders")}
          disabled={model.readOnly}
          onReplace={() => {
            const first = model.targets[0];
            if (first) void model.commit({ ...BORDER_RESET, ...borderLonghands(first) });
          }}
        />
      ) : (
        <>
          <ColorField
            value={color ?? null}
            ariaLabel={t("workspace:canvasInspectorBorderColor")}
            disabled={model.readOnly}
            frameRoot={frameRootOf(model)}
            onPreview={(next) => model.preview({ ...nulls("color"), "border-color": next })}
            onCommit={(next) => void model.commit({ ...nulls("color"), "border-color": next })}
            removeLabel={t("workspace:canvasInspectorRemove", {
              name: t("workspace:canvasInspectorBorder"),
            })}
            onRemove={() => void model.commit(BORDER_RESET)}
          />
          <InspectorRow>
            <InspectorNumberField
              label={<InspectorIcon name="minus-large" />}
              ariaLabel={t("workspace:canvasInspectorBorderWidth")}
              {...width}
              min={0}
              disabled={model.readOnly}
              onPreview={(value) =>
                model.preview((target) => {
                  const side = sidesOf(target);
                  return borderWidthPatch(
                    side === "all" || side === "none" || side === "custom" ? "all" : side,
                    value,
                  );
                })
              }
              onCommit={(input) => {
                if (input.kind !== "length") return;
                void model.commit((target) => {
                  const side = sidesOf(target);
                  return borderWidthPatch(
                    side === "all" || side === "none" || side === "custom" ? "all" : side,
                    input.value,
                  );
                });
              }}
              trailing={
                <InspectorSelect<Side | "all">
                  chip
                  ariaLabel={t("workspace:canvasInspectorBorderSides")}
                  value={
                    sideValue === "all" ||
                    (sideValue && sideValue !== "none" && sideValue !== "custom")
                      ? sideValue
                      : null
                  }
                  mixed={isMixed(sides) || sideValue === "custom"}
                  disabled={model.readOnly}
                  options={[
                    { value: "all", label: t("workspace:canvasInspectorBorderAll") },
                    { value: "top", label: t("workspace:canvasInspectorTop") },
                    { value: "right", label: t("workspace:canvasInspectorRight") },
                    { value: "bottom", label: t("workspace:canvasInspectorBottom") },
                    { value: "left", label: t("workspace:canvasInspectorLeft") },
                  ]}
                  onChange={(next) =>
                    void model.commit((target) =>
                      borderWidthPatch(next, borderWidths(target)[activeSide(target)] || 1),
                    )
                  }
                />
              }
            />
            <InspectorSelect
              ariaLabel={t("workspace:canvasInspectorBorderStyle")}
              value={single(style)}
              mixed={isMixed(style)}
              disabled={model.readOnly}
              options={[
                { value: "solid", label: t("workspace:canvasInspectorBorderSolid") },
                { value: "dashed", label: t("workspace:canvasInspectorBorderDashed") },
                { value: "dotted", label: t("workspace:canvasInspectorBorderDotted") },
                { value: "double", label: t("workspace:canvasInspectorBorderDouble") },
              ]}
              onChange={(next) => void model.commit({ ...nulls("style"), "border-style": next })}
            />
          </InspectorRow>
        </>
      )}
    </InspectorSection>
  );
}

// ── Outline ──────────────────────────────────────────────────────────────

const OUTLINE_RESET: StylePatch = {
  outline: null,
  "outline-style": null,
  "outline-width": null,
  "outline-color": null,
  "outline-offset": null,
};

/** Outline is shown for layers that are not text-only. */
export const outlineTargets = (model: InspectorModel) =>
  model.targets.filter((target) => !target.isFrame && !(target.hasText && !target.container));

const hasOutline = (target: InspectorTarget) =>
  target.computed["outline-style"] !== "none" && pxOf(target.computed["outline-width"]) > 0;

/** The outline as four values: style, colour, width and offset. */
const outlineOf = (target: InspectorTarget): StylePatch => ({
  "outline-style": hasOutline(target) ? target.computed["outline-style"] : "none",
  "outline-width": `${formatNumber(pxOf(target.computed["outline-width"]))}px`,
  "outline-color": toCssColor(resolveCssColor(target.computed["outline-color"]) ?? TRANSPARENT),
  "outline-offset": `${formatNumber(pxOf(target.computed["outline-offset"]))}px`,
});

export function OutlineSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const targets = outlineTargets(model);
  if (targets.length === 0) return null;
  const disabled = model.readOnly;
  const merge = <T,>(read: (target: InspectorTarget) => T) => mergeValues(targets.map(read));
  const commit = (patch: StylePatch | ((target: InspectorTarget) => StylePatch)) =>
    void model.commit(patch, targets);
  const preview = (patch: StylePatch) => model.preview(patch, targets);
  const empty = !targets.some(hasOutline);
  const mixedList = merge((target) => JSON.stringify(outlineOf(target))) === MIXED_VALUE;
  const style = merge((target) => target.computed["outline-style"]);
  const color = merge((target) => outlineOf(target)["outline-color"]!);
  const lengthField = (
    property: "outline-width" | "outline-offset",
    icon: string,
    label: string,
    min?: number,
  ) => (
    <InspectorNumberField
      label={<InspectorIcon name={icon} />}
      ariaLabel={label}
      {...mixedNumber(merge((target) => pxOf(target.computed[property])))}
      {...(min === undefined ? {} : { min })}
      disabled={disabled}
      onPreview={(value) => preview({ [property]: `${formatNumber(value)}px` })}
      onCommit={(input) => {
        if (input.kind === "length")
          commit({
            [property]: formatLength(
              min === undefined ? input.value : Math.max(min, input.value),
              input.unit,
            ),
          });
      }}
    />
  );
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorOutline")}
      empty={empty}
      disabled={disabled}
      onAdd={() =>
        commit({
          ...OUTLINE_RESET,
          "outline-style": "solid",
          "outline-width": "1px",
          "outline-color": "#000000",
        })
      }
    >
      {mixedList ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedOutlines")}
          disabled={disabled}
          onReplace={() => {
            const first = targets[0];
            if (first) commit({ ...OUTLINE_RESET, ...outlineOf(first) });
          }}
        />
      ) : (
        <>
          <ColorField
            value={color ?? null}
            ariaLabel={t("workspace:canvasInspectorOutlineColor")}
            disabled={disabled}
            frameRoot={frameRootOf(model)}
            onPreview={(next) => preview({ "outline-color": next })}
            onCommit={(next) => commit({ "outline-color": next })}
            removeLabel={t("workspace:canvasInspectorRemove", {
              name: t("workspace:canvasInspectorOutline"),
            })}
            onRemove={() => commit(OUTLINE_RESET)}
          />
          <InspectorRow>
            {lengthField(
              "outline-width",
              "minus-large",
              t("workspace:canvasInspectorOutlineWidth"),
              0,
            )}
            <InspectorSelect
              ariaLabel={t("workspace:canvasInspectorOutlineStyle")}
              value={single(style)}
              mixed={isMixed(style)}
              disabled={disabled}
              options={[
                { value: "solid", label: t("workspace:canvasInspectorBorderSolid") },
                { value: "dashed", label: t("workspace:canvasInspectorBorderDashed") },
                { value: "dotted", label: t("workspace:canvasInspectorBorderDotted") },
              ]}
              onChange={(next) => commit({ outline: null, "outline-style": next })}
            />
          </InspectorRow>
          <InspectorRow>
            {lengthField(
              "outline-offset",
              "arrows-all-sides",
              t("workspace:canvasInspectorOutlineOffset"),
            )}
          </InspectorRow>
        </>
      )}
    </InspectorSection>
  );
}

// ── Other styles ─────────────────────────────────────────────────────────

export function OtherStylesSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const rows = new Map<string, Set<string>>();
  for (const target of model.targets)
    for (const declaration of target.declarations) {
      if (isHandledProperty(declaration.property)) continue;
      const values = rows.get(declaration.property) ?? new Set<string>();
      values.add(`${declaration.value}${declaration.important ? " !important" : ""}`);
      rows.set(declaration.property, values);
    }
  if (rows.size === 0) return null;
  return (
    <InspectorSection title={t("workspace:canvasInspectorOtherStyles")} collapsible>
      <ul className="flex flex-col">
        {[...rows].map(([property, values]) => {
          const value = values.size === 1 ? [...values][0]! : "–";
          return (
            <li
              key={property}
              className="group flex h-6 min-w-0 items-center gap-1 rounded-sm ps-1.5 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
            >
              <span
                className="min-w-0 flex-1 truncate font-chat-code text-ui-xs"
                title={`${property}: ${[...values].join(" | ")}`}
              >
                <span className="text-muted-foreground">{property}:</span> {value}
              </span>
              {model.readOnly ? null : (
                <IconButton
                  label={t("workspace:canvasInspectorRemoveStyle", { name: property })}
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => void model.commit({ [property]: null })}
                >
                  <XIcon className="size-3" />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}
