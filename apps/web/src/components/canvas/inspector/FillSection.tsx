// FILE: FillSection.tsx
// Purpose: Inspector Fill section as a fill stack: solid, gradient and image fills shown
//          top first, reordered by dragging, each with a type menu and (above the bottom fill)
//          a blend mode. Gradients edit type, angle, interpolation and colour stops.
// Layer: Canvas editor UI
// Depends on: inspectorValues fill rules (background longhands), ColorField, dnd-kit list.

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { AddPlusIcon, ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { ColorField } from "./ColorField";
import { parseWideColor } from "./inspectorColor";
import {
  InspectorIcon,
  InspectorMixedRow,
  InspectorNumberField,
  InspectorPropertyRow,
  InspectorRow,
  InspectorSection,
  InspectorSelect,
  InspectorSortableList,
} from "./InspectorControls";
import {
  addGradientStop,
  distributeStops,
  formatFills,
  formatGradient,
  formatNumber,
  IMAGE_FIT_LAYOUTS,
  imageFitOf,
  moveItem,
  parseCssColor,
  parseFills,
  splitTopLevel,
  toCssColor,
  DEFAULT_BACKGROUND_LAYOUT,
  type Fill,
  type Gradient,
  type GradientInterpolation,
  type GradientStop,
  type GradientType,
  type ImageFit,
  type StylePatch,
} from "./inspectorValues";
import { BLEND_MODES } from "./StyleSections";
import { resolveCssColor, type InspectorModel, type InspectorTarget } from "./useInspectorModel";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";

/** Longhands a `background` shorthand also set; kept when the shorthand is split up. */
const KEPT_LONGHANDS = [
  ["background-clip", "border-box"],
  ["background-origin", "padding-box"],
  ["background-attachment", "scroll"],
] as const;

/** sRGB colours as the inspector writes them (#RRGGBB[AA]); wider colours stay as written. */
function normalizeColorText(color: string): string {
  const rgba = parseCssColor(color);
  return rgba ? toCssColor(rgba) : color;
}

function normalizeFill(fill: Fill): Fill {
  if (fill.kind === "solid") return { ...fill, color: normalizeColorText(fill.color) };
  if (fill.kind !== "gradient") return fill;
  const stops = fill.gradient.stops.map((stop) => ({
    color: normalizeColorText(stop.color),
    position: stop.position,
  }));
  return { ...fill, gradient: { ...fill.gradient, stops } };
}

/** A target's fill stack, read from its stored style (asset URLs as authored). */
export function fillsOf(target: InspectorTarget): Fill[] {
  const color = resolveCssColor(target.computed["background-color"]);
  // A colour wider than sRGB stays as written, so the picker can show it as clipped.
  const specified = target.specified("background-color");
  const wide = specified && parseWideColor(specified) ? specified : null;
  return parseFills({
    image: target.specified("background-image") || "none",
    color: color && color.a > 0 ? (wide ?? toCssColor(color)) : null,
    blend: target.specified("background-blend-mode"),
    size: target.specified("background-size"),
    position: target.specified("background-position"),
    repeat: target.specified("background-repeat"),
  }).map(normalizeFill);
}

/** The patch that gives `target` exactly `fills`. */
function fillsPatch(target: InspectorTarget, fills: readonly Fill[]): StylePatch {
  const patch: StylePatch = formatFills(fills, { frame: target.isFrame });
  if (target.declared.has("background"))
    for (const [property, initial] of KEPT_LONGHANDS) {
      const value = target.specified(property);
      if (value && value !== initial) patch[property] = value;
    }
  return patch;
}

const sameFills = (a: readonly Fill[], b: readonly Fill[]) =>
  JSON.stringify(formatFills(a)) === JSON.stringify(formatFills(b));

/** A colour with its alpha set, for the second stop of a new gradient. */
function withAlpha(color: string, alpha: number): string {
  const rgba = resolveCssColor(color);
  return rgba ? toCssColor({ ...rgba, a: alpha }) : color;
}

function firstColorOf(fill: Fill): string {
  if (fill.kind === "solid") return fill.color;
  if (fill.kind === "gradient") return fill.gradient.stops[0]?.color ?? "#FFFFFF";
  return "#FFFFFF";
}

/** Switches a fill to a solid colour or a gradient, keeping its colour and blend mode. */
function convertFill(fill: Fill, kind: "solid" | "gradient"): Fill {
  const color = firstColorOf(fill);
  if (kind === "solid")
    return { kind: "solid", color, blend: fill.blend, layout: DEFAULT_BACKGROUND_LAYOUT };
  // The default gradient: the colour fading out downward.
  return {
    kind: "gradient",
    blend: fill.blend,
    layout: DEFAULT_BACKGROUND_LAYOUT,
    gradient: {
      type: "linear",
      angle: 180,
      direction: null,
      interpolation: "oklab",
      shape: "",
      stops: [
        { color, position: 0 },
        { color: withAlpha(color, 0), position: 100 },
      ],
    },
  };
}

/** The CSS a swatch paints for a fill (images use the rendered layer, which has its blob URL). */
function swatchStyle(fill: Fill, rendered: string | undefined): CSSProperties {
  switch (fill.kind) {
    case "solid":
      return { background: fill.color };
    case "gradient":
      return { backgroundImage: formatGradient(fill.gradient) };
    case "image":
      return rendered ? { backgroundImage: rendered, backgroundSize: "cover" } : {};
    case "other":
      return { backgroundImage: fill.value };
  }
}

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

export function FillSection({ model }: { model: InspectorModel }) {
  const { t } = useTranslation();
  const { targets, readOnly } = model;
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<((url: string) => void) | null>(null);
  const stacks = targets.map(fillsOf);
  const first = stacks[0] ?? [];
  const mixed = stacks.some((stack) => !sameFills(stack, first));
  const empty = stacks.every((stack) => stack.length === 0);
  const shared = mixed ? [] : first;
  const renderedLayers = splitTopLevel(targets[0]?.computed["background-image"] ?? "none", ",").map(
    (layer) => layer.trim(),
  );

  const commit = (next: readonly Fill[]) => void model.commit((target) => fillsPatch(target, next));
  const preview = (next: readonly Fill[]) => model.preview((target) => fillsPatch(target, next));
  const replace = (index: number, fill: Fill) =>
    shared.map((item, at) => (at === index ? fill : item));
  const add = () => {
    if (mixed) return commit(first);
    // A new fill goes on top of the stack (fills show top first).
    commit([
      { kind: "solid", color: "#FFFFFF", blend: "normal", layout: DEFAULT_BACKGROUND_LAYOUT },
      ...shared,
    ]);
  };

  /** Opens the file picker; the chosen image becomes a work asset, then `apply` gets its URL. */
  const pickImage = (apply: (url: string) => void) => {
    pendingImage.current = apply;
    fileInput.current?.click();
  };

  return (
    <InspectorSection
      title={t("workspace:canvasInspectorFill")}
      empty={empty}
      disabled={readOnly}
      onAdd={add}
      headerAction={
        <IconButton
          label={t("workspace:canvasInspectorAddFill")}
          tooltip={t("workspace:canvasInspectorAddFill")}
          size="icon-xs"
          onClick={add}
        >
          <AddPlusIcon className="size-3.5" />
        </IconButton>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_TYPES}
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const apply = pendingImage.current;
          event.currentTarget.value = "";
          pendingImage.current = null;
          if (!file || !apply) return;
          void model.editor.commands.importImageAsset(file).then((assetId) => {
            if (assetId) apply(`synara-asset:${assetId}`);
          });
        }}
      />
      {mixed ? (
        <InspectorMixedRow
          label={t("workspace:canvasInspectorMixedFills")}
          disabled={readOnly}
          onReplace={() => commit(first)}
        />
      ) : (
        <InspectorSortableList
          ids={shared.map((_, index) => `fill-${index}`)}
          reorderLabel={(index) => t("workspace:canvasInspectorReorderFill", { number: index + 1 })}
          disabled={readOnly}
          onReorder={(from, to) => commit(moveItem(shared, from, to))}
        >
          {(index) => (
            <FillRow
              model={model}
              fill={shared[index]!}
              rendered={renderedLayers[index]}
              bottom={index === shared.length - 1}
              onPreview={(fill) => preview(replace(index, fill))}
              onCommit={(fill) => commit(replace(index, fill))}
              onRemove={() => commit(shared.filter((_, at) => at !== index))}
              onPickImage={() =>
                pickImage((url) =>
                  commit(
                    replace(index, {
                      kind: "image",
                      url,
                      blend: shared[index]!.blend,
                      layout: IMAGE_FIT_LAYOUTS.cover,
                    }),
                  ),
                )
              }
            />
          )}
        </InspectorSortableList>
      )}
    </InspectorSection>
  );
}

type FillKind = "solid" | "gradient" | "image";

/** One fill of the stack: its own row, a type menu and, for gradients and images, a popover. */
function FillRow({
  model,
  fill,
  rendered,
  bottom,
  onPreview,
  onCommit,
  onRemove,
  onPickImage,
}: {
  model: InspectorModel;
  fill: Fill;
  /** The computed layer (blob URL for images), for the swatch. */
  rendered: string | undefined;
  /** The bottom fill blends with nothing below it, so it has no blend mode. */
  bottom: boolean;
  onPreview: (fill: Fill) => void;
  onCommit: (fill: Fill) => void;
  onRemove: () => void;
  onPickImage: () => void;
}) {
  const { t } = useTranslation();
  const disabled = model.readOnly;
  const removeLabel = t("workspace:canvasInspectorRemove", {
    name: t("workspace:canvasInspectorFill"),
  });
  const menu = disabled ? null : (
    <FillMenu
      fill={fill}
      bottom={bottom}
      onType={(kind) => {
        if (kind === "image") onPickImage();
        else onCommit(convertFill(fill, kind));
      }}
      onBlend={(blend) => onCommit({ ...fill, blend })}
    />
  );
  if (fill.kind === "solid")
    return (
      <ColorField
        value={fill.color}
        ariaLabel={t("workspace:canvasInspectorFill")}
        disabled={disabled}
        frameRoot={() =>
          model.targets[0]
            ? model.editor.elementFor({ kind: "frame", frameId: model.targets[0].frame.id })
            : null
        }
        onPreview={(color) => onPreview({ ...fill, color })}
        onCommit={(color) => onCommit({ ...fill, color })}
        removeLabel={removeLabel}
        onRemove={onRemove}
        trailing={menu}
      />
    );
  return (
    <FillPopoverRow
      fill={fill}
      rendered={rendered}
      disabled={disabled}
      removeLabel={removeLabel}
      onRemove={onRemove}
      menu={menu}
    >
      {fill.kind === "gradient" ? (
        <GradientEditor
          model={model}
          gradient={fill.gradient}
          onPreview={(gradient) => onPreview({ ...fill, gradient })}
          onCommit={(gradient) => onCommit({ ...fill, gradient })}
        />
      ) : fill.kind === "image" ? (
        <ImageEditor
          fill={fill}
          disabled={disabled}
          onFit={(fit) => onCommit({ ...fill, layout: IMAGE_FIT_LAYOUTS[fit] })}
          onReplace={onPickImage}
        />
      ) : null}
    </FillPopoverRow>
  );
}

function fillLabel(t: ReturnType<typeof useTranslation>["t"], fill: Fill): string {
  if (fill.kind === "gradient") return t(GRADIENT_TYPE_KEYS[fill.gradient.type]);
  if (fill.kind === "image") return t("workspace:canvasInspectorImage");
  return t("workspace:canvasInspectorFillCustom");
}

function fillDetail(fill: Fill): string {
  if (fill.kind === "gradient" && fill.gradient.type !== "radial")
    return `${formatNumber(fill.gradient.angle)}°`;
  return "";
}

/** A gradient, image or unparsed fill: swatch and name open its editor. */
function FillPopoverRow({
  fill,
  rendered,
  disabled,
  removeLabel,
  onRemove,
  menu,
  children,
}: {
  fill: Fill;
  rendered: string | undefined;
  disabled: boolean;
  removeLabel: string;
  onRemove: () => void;
  menu: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = fillLabel(t, fill);
  const editable = fill.kind !== "other" && !disabled;
  return (
    <Popover open={open && editable} onOpenChange={setOpen}>
      <InspectorPropertyRow
        active={open}
        disabled={disabled}
        removeLabel={removeLabel}
        onRemove={onRemove}
      >
        <PopoverTrigger
          disabled={!editable}
          aria-label={t("workspace:canvasInspectorEditFill", { name: label })}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-start outline-none"
        >
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-sm bg-center shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]"
            style={swatchStyle(fill, rendered)}
          />
          <span
            className="min-w-0 flex-1 truncate"
            title={fill.kind === "other" ? fill.value : undefined}
          >
            {label}
          </span>
          <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
            {fillDetail(fill)}
          </span>
        </PopoverTrigger>
        {menu}
      </InspectorPropertyRow>
      <PopoverPopup side="left" align="start" sideOffset={12}>
        <div className="flex w-60 flex-col gap-1.5">
          <PopoverTitle className="pb-0.5 text-ui-xs font-semibold">{label}</PopoverTitle>
          {children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const FILL_KIND_KEYS: Record<FillKind, string> = {
  solid: "workspace:canvasInspectorFillSolid",
  gradient: "workspace:canvasInspectorGradient",
  image: "workspace:canvasInspectorImage",
};

/** The fill's type switch and, above the bottom fill, its blend mode. */
function FillMenu({
  fill,
  bottom,
  onType,
  onBlend,
}: {
  fill: Fill;
  bottom: boolean;
  onType: (kind: FillKind) => void;
  onBlend: (blend: string) => void;
}) {
  const { t } = useTranslation();
  const kind = fill.kind === "other" ? "" : fill.kind;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            label={t("workspace:canvasInspectorFillOptions")}
            tooltip={t("workspace:canvasInspectorFillOptions")}
            size="chip"
            className="shrink-0"
          >
            <ChevronDownIcon />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end">
        <MenuRadioGroup
          value={kind}
          onValueChange={(next) => {
            if (next === "solid" || next === "gradient" || next === "image") onType(next);
          }}
        >
          {(Object.keys(FILL_KIND_KEYS) as FillKind[]).map((option) => (
            <MenuRadioItem closeOnClick key={option} value={option}>
              {t(FILL_KIND_KEYS[option])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {bottom ? null : (
          <>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>{t("workspace:canvasInspectorBlendMode")}</MenuSubTrigger>
              <ComposerPickerMenuSubPopup>
                <MenuRadioGroup
                  value={fill.blend}
                  onValueChange={(next) => {
                    if (typeof next === "string") onBlend(next);
                  }}
                >
                  {BLEND_MODES.map(([value, key]) => (
                    <MenuRadioItem closeOnClick key={value} value={value}>
                      {t(key)}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </ComposerPickerMenuSubPopup>
            </MenuSub>
          </>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

// ── Gradient editor ──────────────────────────────────────────────────────

const sorted = (stops: readonly GradientStop[]) =>
  stops.toSorted((a, b) => a.position - b.position);

const GRADIENT_TYPE_KEYS: Record<GradientType, string> = {
  linear: "workspace:canvasInspectorGradientLinear",
  radial: "workspace:canvasInspectorGradientRadial",
  conic: "workspace:canvasInspectorGradientConic",
};

function GradientEditor({
  model,
  gradient,
  onPreview,
  onCommit,
}: {
  model: InspectorModel;
  gradient: Gradient;
  onPreview: (gradient: Gradient) => void;
  onCommit: (gradient: Gradient) => void;
}) {
  const { t } = useTranslation();
  const disabled = model.readOnly;
  const withStop = (index: number, stop: GradientStop) =>
    gradient.stops.map((item, at) => (at === index ? stop : item));
  const frameRoot = () =>
    model.targets[0]
      ? model.editor.elementFor({ kind: "frame", frameId: model.targets[0].frame.id })
      : null;
  return (
    <>
      <InspectorRow label={t("workspace:canvasInspectorGradientType")}>
        <InspectorSelect<GradientType>
          ariaLabel={t("workspace:canvasInspectorGradientType")}
          value={gradient.type}
          disabled={disabled}
          options={(Object.keys(GRADIENT_TYPE_KEYS) as GradientType[]).map((value) => ({
            value,
            label: t(GRADIENT_TYPE_KEYS[value]),
          }))}
          onChange={(type) =>
            onCommit({
              ...gradient,
              type,
              shape: "",
              direction: null,
              angle: type === "radial" ? 0 : gradient.angle,
            })
          }
        />
        {gradient.type === "radial" ? null : (
          <InspectorNumberField
            label={<InspectorIcon name="arrow-rotate-clockwise" className="size-3" />}
            suffix="°"
            ariaLabel={t("workspace:canvasInspectorGradientAngle")}
            value={gradient.angle}
            unit="deg"
            disabled={disabled}
            onPreview={(angle) => onPreview({ ...gradient, angle, direction: null })}
            onCommit={(input) => {
              if (input.kind === "length")
                onCommit({ ...gradient, angle: input.value, direction: null });
            }}
          />
        )}
      </InspectorRow>
      <InspectorRow label={t("workspace:canvasInspectorGradientInterpolation")} columns={1}>
        <InspectorSelect<GradientInterpolation>
          ariaLabel={t("workspace:canvasInspectorGradientInterpolation")}
          value={gradient.interpolation}
          disabled={disabled}
          options={[
            { value: "oklab", label: t("workspace:canvasInspectorInterpolationOklab") },
            { value: "oklch", label: t("workspace:canvasInspectorInterpolationOklch") },
            { value: "srgb", label: t("workspace:canvasInspectorInterpolationSrgb") },
          ]}
          onChange={(interpolation) => onCommit({ ...gradient, interpolation })}
        />
      </InspectorRow>
      <div className="flex flex-col gap-1.5 pt-1">
        {gradient.stops.map((stop, index) => (
          // Stops are positional, like the CSS list they come from.
          // oxlint-disable-next-line no-array-index-key
          <div key={index} className="min-w-0">
            <ColorField
              value={stop.color}
              ariaLabel={t("workspace:canvasInspectorGradientStop", { number: index + 1 })}
              disabled={disabled}
              frameRoot={frameRoot}
              onPreview={(color) =>
                onPreview({ ...gradient, stops: withStop(index, { ...stop, color }) })
              }
              onCommit={(color) =>
                onCommit({ ...gradient, stops: withStop(index, { ...stop, color }) })
              }
              removeLabel={
                gradient.stops.length > 2
                  ? t("workspace:canvasInspectorRemoveStop", { number: index + 1 })
                  : undefined
              }
              onRemove={
                gradient.stops.length > 2
                  ? () =>
                      onCommit({
                        ...gradient,
                        stops: gradient.stops.filter((_, at) => at !== index),
                      })
                  : undefined
              }
              trailing={
                <InspectorNumberField
                  bare
                  ariaLabel={t("workspace:canvasInspectorStopPosition", { number: index + 1 })}
                  suffix="%"
                  unit="%"
                  value={stop.position}
                  min={0}
                  max={100}
                  disabled={disabled}
                  className="w-12 shrink-0 text-muted-foreground"
                  inputClassName="text-end"
                  onPreview={(position) =>
                    onPreview({ ...gradient, stops: withStop(index, { ...stop, position }) })
                  }
                  onCommit={(input) => {
                    if (input.kind !== "length") return;
                    const position = Math.min(100, Math.max(0, input.value));
                    onCommit({
                      ...gradient,
                      stops: sorted(withStop(index, { ...stop, position })),
                    });
                  }}
                />
              }
            />
          </div>
        ))}
      </div>
      {disabled ? null : (
        <div className="flex gap-1.5 pt-1">
          <Button
            variant="ghost"
            size="xs"
            className="flex-1"
            onClick={() => onCommit({ ...gradient, stops: addGradientStop(gradient.stops) })}
          >
            {t("workspace:canvasInspectorAddStop")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="flex-1"
            disabled={gradient.stops.length < 3}
            onClick={() => onCommit({ ...gradient, stops: distributeStops(gradient.stops) })}
          >
            {t("workspace:canvasInspectorDistributeStops")}
          </Button>
        </div>
      )}
    </>
  );
}

// ── Image editor ─────────────────────────────────────────────────────────

function ImageEditor({
  fill,
  disabled,
  onFit,
  onReplace,
}: {
  fill: Extract<Fill, { kind: "image" }>;
  disabled: boolean;
  onFit: (fit: ImageFit) => void;
  onReplace: () => void;
}) {
  const { t } = useTranslation();
  const fit = imageFitOf(fill.layout);
  return (
    <>
      <InspectorRow label={t("workspace:canvasInspectorImageFit")} columns={1}>
        <InspectorSelect<ImageFit>
          ariaLabel={t("workspace:canvasInspectorImageFit")}
          value={fit}
          mixed={fit === null}
          disabled={disabled}
          options={[
            { value: "cover", label: t("workspace:canvasInspectorImageCover") },
            { value: "contain", label: t("workspace:canvasInspectorImageContain") },
            { value: "tile", label: t("workspace:canvasInspectorImageTile") },
          ]}
          onChange={onFit}
        />
      </InspectorRow>
      {disabled ? null : (
        <Button variant="ghost" size="xs" className={cn("w-full")} onClick={onReplace}>
          {t("workspace:canvasInspectorReplaceImage")}
        </Button>
      )}
    </>
  );
}
