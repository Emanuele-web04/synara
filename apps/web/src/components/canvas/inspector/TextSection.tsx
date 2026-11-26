// FILE: TextSection.tsx
// Purpose: Inspector Text, Underline and Text stroke sections for layers with their own text.
//          Text: font family, style and weight, size, line height, letter spacing, horizontal
//          and vertical alignment, colour, and the Formatting popover (alignment, case,
//          wrap, keep words, truncation, max lines). While the layer is being typed into, they
//          read and style the selected range, or the whole block with a caret
//          (`useTextEditingModel`).
// Layer: Canvas editor UI

import { useState } from "react";
import { useTranslation } from "~/i18n";
import { EllipsisIcon } from "~/lib/icons";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { canvasShortcutLabelFor } from "../editor/canvasShortcuts";
import { ShortcutTooltip } from "../editor/ShortcutTooltip";
import { ColorField } from "./ColorField";
import { FontPicker, useCanvasFontCatalog } from "./FontPicker";
import {
  InspectorCheckbox,
  InspectorIcon,
  InspectorMixedRow,
  InspectorNumberField,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  InspectorToggleGroup,
} from "./InspectorControls";
import {
  DECORATION_LINES,
  fontWeightOptions,
  formatNumber,
  isMixed,
  MIXED,
  mergeValues,
  mixedNumber,
  parsePx,
  primaryFontFamily,
  readAutoLength,
  readDecorationLine,
  readLetterSpacing,
  readLineHeight,
  readTextVerticalAlign,
  readTextWrap,
  readTruncation,
  sameUnitValue,
  single,
  textVerticalAlignPatch,
  textWrapPatch,
  toCssColor,
  truncationPatch,
  UNDERLINE_RESET,
  unitValueText,
  type DecorationLine,
  type MaybeMixed,
  type StylePatch,
  type TextWrap,
  type UnitValue,
  type VerticalAlign,
} from "./inspectorValues";
import { frameRootOf } from "./StyleSections";
import {
  resolveCssColor,
  useTextEditingModel,
  type InspectorModel,
  type InspectorTarget,
} from "./useInspectorModel";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";

type TextAlign = "left" | "center" | "right" | "justify";

function textAlignOf(value: string): TextAlign {
  if (value === "center" || value === "-webkit-center") return "center";
  if (value === "justify") return "justify";
  if (value === "right" || value === "end" || value === "-webkit-right") return "right";
  return "left";
}

const WEIGHT_KEYS: Readonly<Record<number, string>> = {
  100: "workspace:canvasInspectorWeight100",
  200: "workspace:canvasInspectorWeight200",
  300: "workspace:canvasInspectorWeight300",
  400: "workspace:canvasInspectorWeight400",
  500: "workspace:canvasInspectorWeight500",
  600: "workspace:canvasInspectorWeight600",
  700: "workspace:canvasInspectorWeight700",
  800: "workspace:canvasInspectorWeight800",
  900: "workspace:canvasInspectorWeight900",
};

/** Layers with their own text: the Text, Underline and Text stroke sections apply. */
export const textTargets = (model: InspectorModel) =>
  model.targets.filter((target) => target.hasText && !target.isFrame);

/** A style option: a weight, upright or italic ("700" or "700i"). */
const styleKey = (weight: string, italic: boolean) => `${weight}${italic ? "i" : ""}`;

const isItalic = (target: InspectorTarget) =>
  target.computed["font-style"] === "italic" || target.computed["font-style"].startsWith("oblique");

export function TextSection({ model: selected }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const model = useTextEditingModel(selected);
  const targets = textTargets(model);
  const catalog = useCanvasFontCatalog(targets.length > 0);
  if (targets.length === 0) return null;
  const disabled = model.readOnly;
  const merge = <T,>(read: (target: InspectorTarget) => T, equals?: (a: T, b: T) => boolean) =>
    mergeValues(targets.map(read), equals);
  const preview = (patch: StylePatch) => model.preview(patch, targets);
  const commit = (patch: StylePatch | ((target: InspectorTarget) => StylePatch)) =>
    void model.commit(patch, targets);

  const family = merge((target) => primaryFontFamily(target.computed["font-family"]));
  const familyName = single(family);
  const entry = familyName
    ? catalog.data?.families.find((item) => item.family.toLowerCase() === familyName.toLowerCase())
    : undefined;
  // Italics: the catalog says whether a family has them; other fonts may be slanted by the browser.
  const italics = entry ? entry.italic : true;
  const weights = fontWeightOptions(entry).map(String);
  const style = merge((target) => styleKey(target.computed["font-weight"], isItalic(target)));
  const styles = weights.flatMap((weight) =>
    italics ? [styleKey(weight, false), styleKey(weight, true)] : [styleKey(weight, false)],
  );
  const currentStyle = single(style);
  if (currentStyle && !styles.includes(currentStyle)) styles.push(currentStyle);
  const styleLabel = (value: string) => {
    const italic = value.endsWith("i");
    const weight = italic ? value.slice(0, -1) : value;
    const key = WEIGHT_KEYS[Number(weight)];
    const name = key ? t(key) : weight;
    if (!italic) return name;
    return weight === "400"
      ? t("workspace:canvasInspectorItalic")
      : t("workspace:canvasInspectorStyleItalic", { weight: name });
  };

  const size = mixedNumber(merge((target) => parsePx(target.computed["font-size"]) ?? 16));
  const lineHeight = merge(
    (target) => readLineHeight(target.declared.get("line-height"), target.computed["line-height"]),
    sameUnitValue,
  );
  const letterSpacing = merge(
    (target) =>
      readLetterSpacing(target.declared.get("letter-spacing"), target.computed["letter-spacing"]),
    sameUnitValue,
  );
  const align = merge((target) => textAlignOf(target.computed["text-align"]));
  const vertical = merge((target) =>
    readTextVerticalAlign({
      display: target.computed.display,
      direction: target.computed["flex-direction"],
      alignItems: target.computed["align-items"],
      justifyContent: target.computed["justify-content"],
      alignContent: target.computed["align-content"],
    }),
  );
  const color = merge((target) => target.computed.color);

  const unitField = (
    value: MaybeMixed<UnitValue> | undefined,
    options: {
      property: string;
      icon: string;
      ariaLabel: string;
      keywords: Readonly<Record<string, string | null>>;
      step: (unit: string) => number;
      min?: number;
    },
  ) => {
    const resolved = single(value);
    const unit = resolved?.unit ?? "px";
    return (
      <InspectorNumberField
        label={<InspectorIcon name={options.icon} />}
        ariaLabel={options.ariaLabel}
        value={resolved?.value ?? null}
        text={resolved?.normal ? t("workspace:canvasInspectorNormal") : undefined}
        mixed={isMixed(value)}
        unit={unit}
        step={options.step(unit)}
        {...(options.min === undefined ? {} : { min: options.min })}
        disabled={disabled}
        onPreview={(next) => preview({ [options.property]: `${formatNumber(next, 3)}${unit}` })}
        onCommit={(input) => {
          const text = unitValueText(input, options.keywords);
          if (text !== undefined) commit({ [options.property]: text });
        }}
      />
    );
  };

  const declaresColor = targets.some((target) => target.declared.has("color"));

  return (
    <InspectorSection
      title={t("workspace:canvasInspectorText")}
      headerAction={disabled ? null : <FormattingPopover model={model} targets={targets} />}
    >
      <FontPicker
        work={model.editor.work}
        value={family}
        disabled={disabled}
        onApply={(value) => commit({ font: null, "font-family": value })}
      />
      <InspectorRow>
        <InspectorSelect
          ariaLabel={t("workspace:canvasInspectorFontStyle")}
          value={currentStyle}
          mixed={isMixed(style)}
          disabled={disabled}
          options={styles.map((value) => ({ value, label: styleLabel(value) }))}
          onChange={(next) => {
            const italic = next.endsWith("i");
            commit({
              "font-weight": italic ? next.slice(0, -1) : next,
              "font-style": italic ? "italic" : null,
            });
          }}
        />
        <InspectorNumberField
          label={<InspectorIcon name="text-size" />}
          ariaLabel={t("workspace:canvasInspectorFontSize")}
          {...size}
          min={1}
          max={2000}
          disabled={disabled}
          onPreview={(next) => preview({ "font-size": `${formatNumber(next)}px` })}
          onCommit={(input) => {
            if (input.kind === "length")
              commit({ "font-size": `${formatNumber(Math.max(1, input.value))}${input.unit}` });
          }}
        />
      </InspectorRow>
      <InspectorRow>
        {unitField(lineHeight, {
          property: "line-height",
          icon: "line-height",
          ariaLabel: t("workspace:canvasInspectorLineHeight"),
          keywords: { normal: "normal", auto: "normal", none: null },
          step: (unit) => (unit === "" ? 0.05 : 1),
          min: 0,
        })}
        {unitField(letterSpacing, {
          property: "letter-spacing",
          icon: "text-indicator",
          ariaLabel: t("workspace:canvasInspectorLetterSpacing"),
          keywords: { normal: null, none: null, auto: null },
          step: (unit) => (unit === "em" ? 0.01 : 0.1),
        })}
      </InspectorRow>
      <InspectorRow>
        <InspectorToggleGroup<Exclude<TextAlign, "justify">>
          ariaLabel={t("workspace:canvasInspectorAlign")}
          value={
            single(align) === "justify"
              ? null
              : (single(align) as Exclude<TextAlign, "justify"> | null)
          }
          disabled={disabled}
          options={[
            {
              value: "left",
              label: t("workspace:canvasInspectorAlignLeft"),
              icon: <InspectorIcon name="alignment-left" />,
            },
            {
              value: "center",
              label: t("workspace:canvasInspectorAlignCenter"),
              icon: <InspectorIcon name="alignment-center" />,
            },
            {
              value: "right",
              label: t("workspace:canvasInspectorAlignRight"),
              icon: <InspectorIcon name="alignment-right" />,
            },
          ]}
          onChange={(next) => commit({ "text-align": next })}
        />
        <InspectorToggleGroup<VerticalAlign>
          ariaLabel={t("workspace:canvasInspectorVerticalAlign")}
          value={single(vertical)}
          disabled={disabled}
          options={[
            {
              value: "top",
              label: t("workspace:canvasInspectorAlignTop"),
              icon: <InspectorIcon name="horizontal-alignment-top" />,
            },
            {
              value: "center",
              label: t("workspace:canvasInspectorAlignMiddle"),
              icon: <InspectorIcon name="horizontal-alignment-center" />,
            },
            {
              value: "bottom",
              label: t("workspace:canvasInspectorAlignBottom"),
              icon: <InspectorIcon name="horizontal-alignment-bottom" />,
            },
          ]}
          onChange={(next) =>
            commit((target) =>
              textVerticalAlignPatch(
                { display: target.computed.display, direction: target.computed["flex-direction"] },
                next,
              ),
            )
          }
        />
      </InspectorRow>
      <ColorField
        value={color ?? null}
        ariaLabel={t("workspace:canvasInspectorTextColor")}
        disabled={disabled}
        frameRoot={() => model.editor.elementFor({ kind: "frame", frameId: targets[0]!.frame.id })}
        onPreview={(next) => preview({ color: next })}
        onCommit={(next) => commit({ color: next })}
        removeLabel={t("workspace:canvasInspectorRemove", {
          name: t("workspace:canvasInspectorTextColor"),
        })}
        onRemove={declaresColor ? () => commit({ color: null }) : undefined}
      />
    </InspectorSection>
  );
}

// ── Formatting ───────────────────────────────────────────────────────────

const CASES = [
  { value: "none", glyph: "–", key: "workspace:canvasInspectorCaseNone" },
  { value: "uppercase", glyph: "AA", key: "workspace:canvasInspectorCaseUpper" },
  { value: "lowercase", glyph: "aa", key: "workspace:canvasInspectorCaseLower" },
  { value: "capitalize", glyph: "Aa", key: "workspace:canvasInspectorCaseTitle" },
] as const;

/** Formatting: alignment (with justify), case, wrap, keep words and truncation. */
function FormattingPopover({
  model,
  targets,
}: {
  model: InspectorModel;
  targets: readonly InspectorTarget[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const merge = <T,>(read: (target: InspectorTarget) => T) => mergeValues(targets.map(read));
  const commit = (patch: StylePatch | ((target: InspectorTarget) => StylePatch)) =>
    void model.commit(patch, targets);
  const align = merge((target) => textAlignOf(target.computed["text-align"]));
  const transform = merge((target) =>
    CASES.some((item) => item.value === target.computed["text-transform"])
      ? target.computed["text-transform"]
      : "none",
  );
  const wrap = merge((target) =>
    readTextWrap({
      mode: target.computed["text-wrap-mode"],
      style: target.computed["text-wrap-style"],
      whiteSpace: target.computed["white-space"],
    }),
  );
  const keepWords = merge((target) => target.computed["word-break"] === "keep-all");
  const truncation = merge((target) =>
    readTruncation({
      lineClamp: target.computed["-webkit-line-clamp"],
      textOverflow: target.computed["text-overflow"],
    }),
  );
  const lines = single(truncation);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label={t("workspace:canvasInspectorFormatting")}
            tooltip={t("workspace:canvasInspectorFormatting")}
            size="icon-xs"
          >
            <InspectorIcon name="text-block" />
          </IconButton>
        }
      />
      <PopoverPopup side="left" align="start" sideOffset={12}>
        <div className="flex w-60 flex-col gap-1.5">
          <PopoverTitle className="pb-0.5 text-ui-xs font-semibold">
            {t("workspace:canvasInspectorFormatting")}
          </PopoverTitle>
          <InspectorRow label={t("workspace:canvasInspectorAlign")} columns={1}>
            <InspectorToggleGroup<TextAlign>
              ariaLabel={t("workspace:canvasInspectorAlign")}
              value={single(align)}
              options={[
                {
                  value: "left",
                  label: t("workspace:canvasInspectorAlignLeft"),
                  icon: <InspectorIcon name="alignment-left" />,
                  tooltip: (
                    <ShortcutTooltip
                      label={t("workspace:canvasInspectorAlignLeft")}
                      shortcut={canvasShortcutLabelFor({ id: "text-align", align: "left" })}
                    />
                  ),
                },
                {
                  value: "center",
                  label: t("workspace:canvasInspectorAlignCenter"),
                  icon: <InspectorIcon name="alignment-center" />,
                  tooltip: (
                    <ShortcutTooltip
                      label={t("workspace:canvasInspectorAlignCenter")}
                      shortcut={canvasShortcutLabelFor({ id: "text-align", align: "center" })}
                    />
                  ),
                },
                {
                  value: "right",
                  label: t("workspace:canvasInspectorAlignRight"),
                  icon: <InspectorIcon name="alignment-right" />,
                  tooltip: (
                    <ShortcutTooltip
                      label={t("workspace:canvasInspectorAlignRight")}
                      shortcut={canvasShortcutLabelFor({ id: "text-align", align: "right" })}
                    />
                  ),
                },
                {
                  value: "justify",
                  label: t("workspace:canvasInspectorAlignJustify"),
                  icon: <InspectorIcon name="alignment-justify" />,
                  tooltip: (
                    <ShortcutTooltip
                      label={t("workspace:canvasInspectorAlignJustify")}
                      shortcut={canvasShortcutLabelFor({ id: "text-align", align: "justify" })}
                    />
                  ),
                },
              ]}
              onChange={(next) => commit({ "text-align": next })}
            />
          </InspectorRow>
          <InspectorRow label={t("workspace:canvasInspectorCase")} columns={1}>
            <InspectorToggleGroup<(typeof CASES)[number]["value"]>
              ariaLabel={t("workspace:canvasInspectorCase")}
              value={single(transform) as (typeof CASES)[number]["value"] | null}
              options={CASES.map((item) => ({
                value: item.value,
                label: t(item.key),
                icon: <span className="text-ui-xs font-medium">{item.glyph}</span>,
              }))}
              onChange={(next) => commit({ "text-transform": next === "none" ? null : next })}
            />
          </InspectorRow>
          <InspectorRow label={t("workspace:canvasInspectorTextWrap")} columns={1}>
            <InspectorSelect<TextWrap>
              ariaLabel={t("workspace:canvasInspectorTextWrap")}
              value={single(wrap)}
              mixed={isMixed(wrap)}
              options={[
                { value: "none", label: t("workspace:canvasInspectorWrapNone") },
                { value: "normal", label: t("workspace:canvasInspectorWrapNormal") },
                { value: "pretty", label: t("workspace:canvasInspectorWrapPretty") },
                { value: "balance", label: t("workspace:canvasInspectorWrapBalance") },
              ]}
              onChange={(next) =>
                commit((target) => textWrapPatch(next, target.declared.get("white-space")))
              }
            />
          </InspectorRow>
          <div className="flex flex-col gap-2 pt-1">
            <InspectorCheckbox
              label={t("workspace:canvasInspectorKeepWords")}
              checked={keepWords === true}
              indeterminate={isMixed(keepWords)}
              onChange={(checked) => commit({ "word-break": checked ? "keep-all" : null })}
            />
            <InspectorCheckbox
              label={t("workspace:canvasInspectorTruncate")}
              checked={lines !== null && !isMixed(truncation)}
              indeterminate={isMixed(truncation)}
              onChange={(checked) => commit(truncationPatch(checked ? 1 : null))}
            />
          </div>
          <InspectorRow label={t("workspace:canvasInspectorMaxLines")}>
            <InspectorNumberField
              ariaLabel={t("workspace:canvasInspectorMaxLines")}
              value={lines}
              mixed={isMixed(truncation)}
              unit=""
              min={1}
              max={100}
              disabled={lines === null}
              onCommit={(input) => {
                if (input.kind === "length") commit(truncationPatch(Math.max(1, input.value)));
              }}
            />
          </InspectorRow>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// ── Underline ────────────────────────────────────────────────────────────

const DECORATION_KEYS: Record<DecorationLine, string> = {
  underline: "workspace:canvasInspectorUnderline",
  overline: "workspace:canvasInspectorOverline",
  "line-through": "workspace:canvasInspectorStrikethrough",
};
const SHAPE_KEYS = {
  solid: "workspace:canvasInspectorBorderSolid",
  dashed: "workspace:canvasInspectorBorderDashed",
  dotted: "workspace:canvasInspectorBorderDotted",
  wavy: "workspace:canvasInspectorUnderlineWavy",
} as const;

const decorationOf = (target: InspectorTarget) =>
  readDecorationLine(target.computed["text-decoration-line"]);

/** The underline as one value, for comparison across nodes. */
function underlineOf(target: InspectorTarget): StylePatch {
  const color = resolveCssColor(target.computed["text-decoration-color"]);
  return {
    "text-decoration-line": decorationOf(target),
    "text-decoration-style": target.computed["text-decoration-style"],
    "text-decoration-color":
      target.declared.has("text-decoration-color") && color ? toCssColor(color) : null,
    "text-decoration-thickness":
      target.specified("text-decoration-thickness") || target.computed["text-decoration-thickness"],
    "text-underline-offset":
      target.specified("text-underline-offset") || target.computed["text-underline-offset"],
    "text-decoration-skip-ink": target.computed["text-decoration-skip-ink"],
  };
}

export function UnderlineSection({ model: selected }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const model = useTextEditingModel(selected);
  const targets = textTargets(model);
  if (targets.length === 0) return null;
  const disabled = model.readOnly;
  const merge = <T,>(read: (target: InspectorTarget) => T, equals?: (a: T, b: T) => boolean) =>
    mergeValues(targets.map(read), equals);
  const commit = (patch: StylePatch) => void model.commit(patch, targets);
  const preview = (patch: StylePatch) => model.preview(patch, targets);
  const empty = targets.every((target) => decorationOf(target) === null);
  const mixedList = merge((target) => JSON.stringify(underlineOf(target))) === MIXED;
  const line = merge(decorationOf);
  const shape = merge((target) => target.computed["text-decoration-style"]);
  const skip = merge((target) =>
    target.computed["text-decoration-skip-ink"] === "none" ? "none" : "auto",
  );
  const color = merge((target) => target.computed["text-decoration-color"]);
  const declaresColor = targets.some((target) => target.declared.has("text-decoration-color"));
  const lengthField = (
    property: "text-decoration-thickness" | "text-underline-offset",
    icon: string,
    ariaLabel: string,
  ) => {
    const value = merge(
      (target) => readAutoLength(target.specified(property), target.computed[property]),
      (a, b) => a.value === b.value && a.unit === b.unit && Boolean(a.normal) === Boolean(b.normal),
    );
    const resolved = single(value);
    const unit = resolved?.unit ?? "px";
    return (
      <InspectorNumberField
        label={<InspectorIcon name={icon} />}
        ariaLabel={ariaLabel}
        value={resolved?.value ?? null}
        text={resolved?.normal ? t("workspace:canvasInspectorAuto") : undefined}
        mixed={isMixed(value)}
        unit={unit}
        min={property === "text-decoration-thickness" ? 0 : -1000}
        disabled={disabled}
        onPreview={(next) => preview({ [property]: `${formatNumber(next)}${unit}` })}
        onCommit={(input) => {
          const text = unitValueText(input, { auto: "auto", normal: "auto", none: null });
          if (text !== undefined) commit({ [property]: text });
        }}
      />
    );
  };
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorUnderline")}
      empty={empty}
      disabled={disabled}
      onAdd={() => commit({ ...UNDERLINE_RESET, "text-decoration-line": "underline" })}
      headerAction={
        mixedList || disabled ? null : (
          <Menu>
            <MenuTrigger
              render={
                <IconButton label={t("workspace:canvasInspectorMoreUnderline")} size="icon-xs">
                  <EllipsisIcon className="size-3.5" />
                </IconButton>
              }
            />
            <ComposerPickerMenuPopup align="end">
              <RadioSubmenu
                label={t("workspace:canvasInspectorUnderlineShape")}
                value={single(shape) as keyof typeof SHAPE_KEYS | null}
                options={(Object.keys(SHAPE_KEYS) as Array<keyof typeof SHAPE_KEYS>).map(
                  (value) => ({ value, label: t(SHAPE_KEYS[value]) }),
                )}
                onChange={(value) =>
                  commit({ "text-decoration-style": value === "solid" ? null : value })
                }
              />
              <RadioSubmenu
                label={t("workspace:canvasInspectorUnderlinePlacement")}
                value={single(line)}
                options={DECORATION_LINES.map((value) => ({
                  value,
                  label: t(DECORATION_KEYS[value]),
                }))}
                onChange={(value) =>
                  commit({ "text-decoration": null, "text-decoration-line": value })
                }
              />
              <RadioSubmenu
                label={t("workspace:canvasInspectorUnderlineOverlap")}
                value={single(skip)}
                options={[
                  { value: "auto" as const, label: t("workspace:canvasInspectorSkipInk") },
                  { value: "none" as const, label: t("workspace:canvasInspectorDrawOver") },
                ]}
                onChange={(value) =>
                  commit({ "text-decoration-skip-ink": value === "auto" ? null : "none" })
                }
              />
              <MenuSeparator />
              <MenuItem
                disabled={!declaresColor}
                onClick={() => commit({ "text-decoration-color": null })}
              >
                {t("workspace:canvasInspectorResetColor")}
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        )
      }
    >
      {mixedList ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedUnderlines")}
          disabled={disabled}
          onReplace={() => {
            const first = targets[0];
            if (first) commit({ ...UNDERLINE_RESET, ...underlineOf(first) });
          }}
        />
      ) : (
        <>
          <ColorField
            value={color ?? null}
            ariaLabel={t("workspace:canvasInspectorUnderlineColor")}
            disabled={disabled}
            frameRoot={frameRootOf(model)}
            onPreview={(next) => preview({ "text-decoration-color": next })}
            onCommit={(next) => commit({ "text-decoration-color": next })}
            removeLabel={t("workspace:canvasInspectorRemove", {
              name: t("workspace:canvasInspectorUnderline"),
            })}
            onRemove={() => commit(UNDERLINE_RESET)}
          />
          <InspectorRow>
            {lengthField(
              "text-decoration-thickness",
              "line-thickness",
              t("workspace:canvasInspectorUnderlineThickness"),
            )}
            {lengthField(
              "text-underline-offset",
              "arrow-down",
              t("workspace:canvasInspectorUnderlineOffset"),
            )}
          </InspectorRow>
        </>
      )}
    </InspectorSection>
  );
}

/** One option group of a menu as a submenu of radio rows (compact menus). */
function RadioSubmenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>{label}</MenuSubTrigger>
      <ComposerPickerMenuSubPopup>
        <MenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            const option = options.find((item) => item.value === next);
            if (option) onChange(option.value);
          }}
        >
          {options.map((option) => (
            <MenuRadioItem closeOnClick key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}

// ── Text stroke ──────────────────────────────────────────────────────────

const TEXT_STROKE_RESET: StylePatch = {
  "-webkit-text-stroke": null,
  "-webkit-text-stroke-width": null,
  "-webkit-text-stroke-color": null,
  "paint-order": null,
};

const strokeWidthOf = (target: InspectorTarget) =>
  parsePx(target.computed["-webkit-text-stroke-width"]) ?? 0;

type StrokePlacement = "above" | "below";

/** Below fill paints the stroke first (`paint-order: stroke`), so the fill covers its inner half. */
const placementOf = (target: InspectorTarget): StrokePlacement =>
  target.computed["paint-order"].trim().startsWith("stroke") ? "below" : "above";

export function TextStrokeSection({ model: selected }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const model = useTextEditingModel(selected);
  const targets = textTargets(model);
  if (targets.length === 0) return null;
  const disabled = model.readOnly;
  const merge = <T,>(read: (target: InspectorTarget) => T) => mergeValues(targets.map(read));
  const commit = (patch: StylePatch) => void model.commit(patch, targets);
  const preview = (patch: StylePatch) => model.preview(patch, targets);
  const empty = targets.every((target) => strokeWidthOf(target) === 0);
  const color = merge((target) => target.computed["-webkit-text-stroke-color"]);
  const placement = merge(placementOf);
  return (
    <InspectorSection
      title={t("workspace:canvasInspectorTextStroke")}
      empty={empty}
      disabled={disabled}
      onAdd={() =>
        commit({
          ...TEXT_STROKE_RESET,
          "-webkit-text-stroke-width": "1px",
          "-webkit-text-stroke-color": "#000000",
        })
      }
    >
      <ColorField
        value={color ?? null}
        ariaLabel={t("workspace:canvasInspectorTextStrokeColor")}
        disabled={disabled}
        frameRoot={frameRootOf(model)}
        onPreview={(next) => preview({ "-webkit-text-stroke-color": next })}
        onCommit={(next) => commit({ "-webkit-text-stroke-color": next })}
        removeLabel={t("workspace:canvasInspectorRemove", {
          name: t("workspace:canvasInspectorTextStroke"),
        })}
        onRemove={() => commit(TEXT_STROKE_RESET)}
      />
      <InspectorRow>
        <InspectorNumberField
          label={<InspectorIcon name="line-thickness" />}
          ariaLabel={t("workspace:canvasInspectorTextStrokeWidth")}
          {...mixedNumber(merge(strokeWidthOf))}
          min={0}
          disabled={disabled}
          onPreview={(value) =>
            preview({ "-webkit-text-stroke-width": `${formatNumber(value)}px` })
          }
          onCommit={(input) => {
            if (input.kind === "length")
              commit({
                "-webkit-text-stroke": null,
                "-webkit-text-stroke-width": `${formatNumber(Math.max(0, input.value))}${input.unit}`,
              });
          }}
        />
        <InspectorSelect<StrokePlacement>
          ariaLabel={t("workspace:canvasInspectorTextStrokePlacement")}
          value={single(placement)}
          mixed={isMixed(placement)}
          disabled={disabled}
          options={[
            { value: "above", label: t("workspace:canvasInspectorStrokeAboveFill") },
            { value: "below", label: t("workspace:canvasInspectorStrokeBelowFill") },
          ]}
          onChange={(next) => commit({ "paint-order": next === "below" ? "stroke fill" : null })}
        />
      </InspectorRow>
    </InspectorSection>
  );
}
