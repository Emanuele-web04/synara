// FILE: ColorPicker.tsx
// Purpose: The canvas colour picker: a saturation/value area in OKHSV
//          (uniform hue, the default) or classic HSV (right-click toggles), vertical alpha and
//          hue sliders, then Previous/New, the Clipped badge, OKLCH/HSL/RGB channel rows with
//          copy buttons, and a text field that takes any CSS colour, with a format menu.
// Layer: Canvas editor UI
// Depends on: inspectorColor (colour spaces), Base UI slider primitive, ui/menu.

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTranslation } from "~/i18n";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { INSPECTOR_FIELD_CLASS_NAME, INSPECTOR_INPUT_CLASS_NAME } from "./InspectorControls";
import {
  colorChannels,
  COLOR_FORMATS,
  formatColor,
  linearToRgba,
  nudgeNumberAt,
  okhsvSampler,
  pickerToRgba,
  rgbaToPicker,
  type ColorFormat,
  type Hsv,
  type PickerSpace,
} from "./inspectorColor";
import { clamp, sameColor, toCssColor, type Rgba } from "./inspectorValues";

const AREA_SIZE = 144;
/** The area is drawn at a lower resolution and smoothed: the gradients have no fine detail. */
const AREA_SAMPLES = 64;
const FORMAT_STORAGE_KEY = "synara.canvas.colorFormat";
const SPACE_STORAGE_KEY = "synara.canvas.colorSpace";

/** Checkerboard under translucent colours. */
export const CHECKER_STYLE: CSSProperties = {
  backgroundImage: "conic-gradient(#d4d4d4 25%, #ffffff 0 50%, #d4d4d4 0 75%, #ffffff 0)",
  backgroundSize: "8px 8px",
};

const cssRgba = (color: Rgba) => `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;

const FormatSchema = Schema.Literals(["hex", "rgb", "hsl", "oklch"]);
const SpaceSchema = Schema.Literals(["okhsv", "hsv"]);

/** Colour space names are the same in every language; Hex is translated. */
const FORMAT_LABELS: Record<Exclude<ColorFormat, "hex">, string> = {
  oklch: "OKLCH",
  hsl: "HSL",
  rgb: "RGB",
};

export function ColorPicker({
  color,
  previous,
  clipped,
  disabled,
  onChange,
  onCommit,
  onCommitText,
  onDragStart,
}: {
  color: Rgba;
  /** The colour when the picker opened (the Previous swatch); clicking it reverts. */
  previous: Rgba | null;
  /** The stored colour lies outside sRGB; the badge clamps it. */
  clipped: boolean;
  disabled: boolean;
  /** Live change while dragging (preview; saved once the pointer is up). */
  onChange: (color: Rgba) => void;
  /** A settled pick: saved now. */
  onCommit: (color: Rgba) => void;
  /** A typed colour kept as written (a colour wider than sRGB). */
  onCommitText: (text: string) => void;
  onDragStart: () => void;
}) {
  const { t } = useTranslation();
  // Per viewer: the picker's choices are a personal preference.
  const [space, setSpace] = useLocalStorage<PickerSpace, PickerSpace>(
    SPACE_STORAGE_KEY,
    "okhsv",
    SpaceSchema,
  );
  // The picker keeps its own hue, saturation and value so greys and black keep the hue.
  const [hsv, setHsv] = useState<Hsv>(() => rgbaToPicker(space, color, 0));
  const lastColor = useRef(color);
  useEffect(() => {
    if (sameColor(color, lastColor.current)) return;
    lastColor.current = color;
    setHsv((current) => {
      const next = rgbaToPicker(space, color, current.h);
      return sameColor(pickerToRgba(space, current, color.a), color) ? current : next;
    });
  }, [color, space]);

  const emit = (next: Hsv, alpha = color.a) => {
    setHsv(next);
    const rgba = pickerToRgba(space, next, alpha);
    lastColor.current = rgba;
    onChange(rgba);
  };
  const switchSpace = () => {
    const next = space === "okhsv" ? "hsv" : "okhsv";
    setSpace(next);
    setHsv(rgbaToPicker(next, color, hsv.h));
  };

  return (
    <div className="flex gap-3">
      <div className="flex shrink-0 gap-2" onPointerDownCapture={onDragStart}>
        <ColorArea
          space={space}
          hsv={hsv}
          disabled={disabled}
          label={t(
            space === "okhsv"
              ? "workspace:canvasInspectorColorAreaUniform"
              : "workspace:canvasInspectorColorAreaClassic",
          )}
          onChange={(s, v) => emit({ ...hsv, s, v })}
          onToggleSpace={switchSpace}
        />
        <VerticalSlider
          label={t("workspace:canvasInspectorAlpha")}
          value={Math.round(color.a * 100)}
          max={100}
          disabled={disabled}
          trackStyle={{
            ...CHECKER_STYLE,
            backgroundImage: `linear-gradient(to top, ${cssRgba({ ...color, a: 0 })}, ${cssRgba({ ...color, a: 1 })}), ${String(CHECKER_STYLE.backgroundImage)}`,
            backgroundSize: "100% 100%, 8px 8px",
          }}
          onChange={(value) => emit(hsv, value / 100)}
        />
        <VerticalSlider
          label={t("workspace:canvasInspectorHue")}
          value={Math.round(hsv.h)}
          max={360}
          disabled={disabled}
          trackStyle={{ backgroundImage: hueGradient(space) }}
          onChange={(value) => emit({ ...hsv, h: value % 360 })}
        />
      </div>
      <ColorDetails
        color={color}
        previous={previous}
        clipped={clipped}
        disabled={disabled}
        onCommit={onCommit}
        onCommitText={onCommitText}
      />
    </div>
  );
}

/** The hue strip, bottom to top, in the area's space. */
function hueGradient(space: PickerSpace): string {
  const stops: string[] = [];
  for (let step = 0; step <= 12; step++) {
    const hue = step * 30;
    const rgba =
      space === "okhsv"
        ? linearToRgba(okhsvSampler(hue)(1, 1))
        : pickerToRgba("hsv", { h: hue, s: 1, v: 1 }, 1);
    stops.push(`${toCssColor(rgba)} ${(step / 12) * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
}

/** Saturation (x) and value (y) at the current hue; arrows move 1%, Shift 10%. */
function ColorArea({
  space,
  hsv,
  disabled,
  label,
  onChange,
  onToggleSpace,
}: {
  space: PickerSpace;
  hsv: Hsv;
  disabled: boolean;
  label: string;
  onChange: (s: number, v: number) => void;
  onToggleSpace: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const image = context.createImageData(AREA_SAMPLES, AREA_SAMPLES);
    const sample = space === "okhsv" ? okhsvSampler(hsv.h) : null;
    for (let y = 0; y < AREA_SAMPLES; y++) {
      const v = 1 - y / (AREA_SAMPLES - 1);
      for (let x = 0; x < AREA_SAMPLES; x++) {
        const s = x / (AREA_SAMPLES - 1);
        const rgba = sample
          ? linearToRgba(sample(s, v))
          : pickerToRgba("hsv", { h: hsv.h, s, v }, 1);
        const at = (y * AREA_SAMPLES + x) * 4;
        image.data[at] = rgba.r;
        image.data[at + 1] = rgba.g;
        image.data[at + 2] = rgba.b;
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [hsv.h, space]);

  const pick = (clientX: number, clientY: number) => {
    const box = area.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    onChange(
      clamp((clientX - box.left) / box.width, 0, 1),
      clamp(1 - (clientY - box.top) / box.height, 0, 1),
    );
  };
  return (
    <div
      ref={area}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
      aria-disabled={disabled || undefined}
      data-space={space}
      className="relative shrink-0 touch-none cursor-crosshair overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width: AREA_SIZE, height: AREA_SIZE }}
      onContextMenu={(event) => {
        event.preventDefault();
        onToggleSpace();
      }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser no longer tracks cannot be captured; the press still picks.
        }
        pick(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        pick(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = event.shiftKey ? 0.1 : 0.01;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        onChange(clamp(hsv.s + move[0], 0, 1), clamp(hsv.v + move[1], 0, 1));
      }}
    >
      <canvas
        ref={canvas}
        width={AREA_SAMPLES}
        height={AREA_SAMPLES}
        aria-hidden
        className="absolute inset-0 size-full"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute size-3 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3)]"
        style={{ left: `${hsv.s * 100}%`, bottom: `${hsv.v * 100}%` }}
      />
    </div>
  );
}

function VerticalSlider({
  label,
  value,
  max,
  disabled,
  trackStyle,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  trackStyle: CSSProperties;
  onChange: (value: number) => void;
}) {
  return (
    <SliderPrimitive.Root
      value={value}
      min={0}
      max={max}
      step={1}
      largeStep={10}
      orientation="vertical"
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={(next) => {
        if (typeof next === "number") onChange(next);
      }}
      className="flex touch-none select-none"
      style={{ height: AREA_SIZE }}
    >
      <SliderPrimitive.Control className="relative flex h-full w-3 cursor-pointer">
        <SliderPrimitive.Track
          className="relative h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--border)]"
          style={trackStyle}
        />
        <SliderPrimitive.Thumb
          aria-label={label}
          className="h-1.5 w-3 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.3)] outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

/**
 * Copies one channel row's colour: the app's copied state (a check for a moment, "Copied" in the
 * tooltip), or the error toast when the clipboard refuses.
 */
function CopyColorButton({ format, text }: { format: string; text: string }) {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (cause) =>
      toastManager.add({
        type: "error",
        title: t("workspace:canvasCopyCodeFailed"),
        description: cause.message,
      }),
  });
  const label = isCopied
    ? t("common:copied", { value0: format })
    : t("workspace:canvasInspectorCopyColor", { format });
  return (
    <IconButton
      label={label}
      tooltip={label}
      className="-me-1"
      data-copied={isCopied || undefined}
      onClick={() => copyToClipboard(text, undefined)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

/** The right column: Previous/New, Clipped, the channel rows and the text field. */
function ColorDetails({
  color,
  previous,
  clipped,
  disabled,
  onCommit,
  onCommitText,
}: {
  color: Rgba;
  previous: Rgba | null;
  clipped: boolean;
  disabled: boolean;
  onCommit: (color: Rgba) => void;
  onCommitText: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useLocalStorage<ColorFormat, ColorFormat>(
    FORMAT_STORAGE_KEY,
    "hex",
    FormatSchema,
  );
  const channels = colorChannels(color);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div
        className="flex h-8 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]"
        style={CHECKER_STYLE}
      >
        <button
          type="button"
          aria-label={t("workspace:canvasInspectorPreviousColor")}
          title={t("workspace:canvasInspectorPreviousColor")}
          disabled={disabled || !previous}
          className="h-full flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ background: previous ? cssRgba(previous) : "transparent" }}
          onClick={() => previous && onCommit(previous)}
        />
        <span
          aria-label={t("workspace:canvasInspectorNewColor")}
          role="img"
          className="h-full flex-1"
          style={{ background: cssRgba(color) }}
        />
      </div>
      {clipped ? (
        <Button
          variant="outline"
          size="xs"
          disabled={disabled}
          title={t("workspace:canvasInspectorClippedHint")}
          className="self-start"
          onClick={() => onCommit(color)}
        >
          {t("workspace:canvasInspectorClipped")}
        </Button>
      ) : null}
      {(["oklch", "hsl", "rgb"] as const).map((name) => (
        // The values get the row's width (the copy button only takes its 24px), so the
        // longest one, HSL with decimals, fits without being cut.
        <div key={name} className="flex h-6 min-w-0 items-center gap-1 text-ui-xs">
          <span className="w-9 shrink-0 text-muted-foreground">{FORMAT_LABELS[name]}</span>
          <span
            data-color-channels={name}
            className="min-w-0 flex-1 truncate text-foreground tabular-nums"
          >
            {channels[name].join(" ")}
          </span>
          <CopyColorButton format={FORMAT_LABELS[name]} text={formatColor(color, name)} />
        </div>
      ))}
      <ColorTextField
        color={color}
        format={format}
        disabled={disabled}
        onCommitText={onCommitText}
        onFormat={setFormat}
      />
    </div>
  );
}

/** Any CSS colour; arrow keys nudge the number under the caret. */
function ColorTextField({
  color,
  format,
  disabled,
  onCommitText,
  onFormat,
}: {
  color: Rgba;
  format: ColorFormat;
  disabled: boolean;
  onCommitText: (text: string) => void;
  onFormat: (format: ColorFormat) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatColor(color, format);
  const submit = (text: string) => {
    setDraft(null);
    const trimmed = text.trim();
    if (trimmed && trimmed !== formatColor(color, format)) onCommitText(trimmed);
  };
  return (
    <div className={cn(INSPECTOR_FIELD_CLASS_NAME, "pe-0.5")}>
      <input
        aria-label={t("workspace:canvasInspectorColorText")}
        className={INSPECTOR_INPUT_CLASS_NAME}
        spellCheck={false}
        disabled={disabled}
        value={shown}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => draft !== null && submit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit(event.currentTarget.value);
          } else if (event.key === "Escape") setDraft(null);
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            const input = event.currentTarget;
            const nudged = nudgeNumberAt(
              input.value,
              input.selectionStart ?? 0,
              event.key === "ArrowUp" ? 1 : -1,
              event.shiftKey,
            );
            if (!nudged) return;
            event.preventDefault();
            setDraft(nudged.text);
            onCommitText(nudged.text);
            requestAnimationFrame(() => input.setSelectionRange(nudged.caret, nudged.caret));
          }
        }}
      />
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              label={t("workspace:canvasInspectorColorFormat")}
              tooltip={t("workspace:canvasInspectorColorFormat")}
              size="chip"
              className="shrink-0"
              disabled={disabled}
            >
              <ChevronDownIcon />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end">
          <MenuRadioGroup
            value={format}
            onValueChange={(next) => {
              if (COLOR_FORMATS.includes(next as ColorFormat)) {
                setDraft(null);
                onFormat(next as ColorFormat);
              }
            }}
          >
            {COLOR_FORMATS.map((option) => (
              <MenuRadioItem closeOnClick key={option} value={option}>
                {option === "hex" ? t("workspace:canvasInspectorFormatHex") : FORMAT_LABELS[option]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}
