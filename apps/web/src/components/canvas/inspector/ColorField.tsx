// FILE: ColorField.tsx
// Purpose: Inspector color row (swatch, hex, opacity, remove) on the shared property row, and
//          its picker popover: the eyedropper (I), the colour picker (area, alpha and hue,
//          Previous/New, Clipped, channels, text and format), hex and opacity fields, and the
//          colors already used in the frame.
// Layer: Canvas editor UI
// Depends on: ColorPicker, ui/popover, InspectorPropertyRow, InspectorNumberField.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { EyedropperIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { IconButton } from "../../ui/icon-button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHECKER_STYLE, ColorPicker } from "./ColorPicker";
import {
  INSPECTOR_FIELD_CLASS_NAME,
  INSPECTOR_INPUT_CLASS_NAME,
  InspectorNumberField,
  InspectorPropertyRow,
} from "./InspectorControls";
import { isOutOfSrgb, parseWideColor } from "./inspectorColor";
import {
  formatHex,
  isMixed,
  sameColor,
  toCssColor,
  type MaybeMixed,
  type Rgba,
} from "./inspectorValues";
import { collectFrameColors, resolveCssColor } from "./useInspectorModel";

const COMMIT_DELAY_MS = 150;
const FALLBACK_COLOR: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** The app's focus ring around the swatch whose picker is open. */
const SWATCH_RING_CLASS_NAME = "ring-2 ring-ring ring-offset-1 ring-offset-background";

/** Keys typed into a field never reach the picker's own shortcuts. */
const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperConstructor | null =>
  typeof window !== "undefined" && "EyeDropper" in window
    ? ((window as unknown as { EyeDropper: EyeDropperConstructor }).EyeDropper ?? null)
    : null;

export function ColorSwatch({
  color,
  mixed = false,
  className,
}: {
  color: Rgba | null;
  mixed?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // The hairline sits over the colour, so a white swatch on the light field (or a black one
        // on the dark field) keeps its edge.
        "relative block size-4 shrink-0 overflow-hidden rounded-sm after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_16%,transparent)] after:content-['']",
        className,
      )}
      style={CHECKER_STYLE}
    >
      <span
        className="absolute inset-0"
        style={{
          background: mixed
            ? "linear-gradient(135deg, #d4d4d4 0 50%, #737373 50% 100%)"
            : color
              ? `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`
              : "transparent",
        }}
      />
    </span>
  );
}

/** The hex text of a color; Enter or blur submits, Escape restores the stored value. */
function HexInput({
  color,
  mixed,
  ariaLabel,
  disabled,
  className,
  onSubmit,
}: {
  color: Rgba | null;
  mixed: boolean;
  ariaLabel: string;
  disabled: boolean;
  className?: string;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Escape discards the typed color; the blur it causes must not submit it. */
  const discardOnBlur = useRef(false);
  const submit = () => {
    if (draft === null) return;
    setDraft(null);
    onSubmit(draft);
  };
  return (
    <input
      aria-label={ariaLabel}
      className={cn(INSPECTOR_INPUT_CLASS_NAME, "uppercase", className)}
      disabled={disabled}
      spellCheck={false}
      placeholder={mixed ? "–" : undefined}
      value={draft ?? (mixed ? "" : color ? formatHex(color) : "")}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (discardOnBlur.current) {
          discardOnBlur.current = false;
          setDraft(null);
        } else submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          submit();
          event.currentTarget.select();
        } else if (event.key === "Escape") {
          setDraft(null);
          discardOnBlur.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function ColorField({
  value,
  ariaLabel,
  disabled = false,
  frameRoot,
  onPreview,
  onCommit,
  removeLabel,
  onRemove,
  trailing,
}: {
  /** Any CSS color (computed values are fine), MIXED, or null when unset. */
  value: MaybeMixed<string> | null;
  ariaLabel: string;
  disabled?: boolean;
  /** The frame whose colors are offered as swatches. */
  frameRoot?: (() => HTMLElement | null) | undefined;
  onPreview: (color: string) => void;
  onCommit: (color: string) => void;
  /** The row's remove button (Fill, Text color, Border); omitted inside popovers. */
  removeLabel?: string | undefined;
  onRemove?: (() => void) | undefined;
  /** A control at the end of the field (a fill's type menu, a gradient stop's position). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const mixed = isMixed(value);
  const color = useMemo(
    () => (value === null || isMixed(value) ? null : resolveCssColor(value)),
    [value],
  );
  const [open, setOpen] = useState(false);
  const [previous, setPrevious] = useState<Rgba | null>(null);
  const [draft, setDraft] = useState<Rgba | null>(null);
  /** The stored colour is wider than sRGB (oklch, display-p3): the picker shows Clipped. */
  const clipped = useMemo(() => {
    if (value === null || isMixed(value)) return false;
    const wide = parseWideColor(value);
    return wide !== null && isOutOfSrgb(wide.linear);
  }, [value]);
  const [frameColors, setFrameColors] = useState<string[]>([]);
  const timer = useRef<number | null>(null);
  const dragging = useRef(false);
  const pending = useRef<Rgba | null>(null);
  const committed = useRef<Rgba | null>(null);
  const latestCommit = useRef(onCommit);
  useEffect(() => {
    latestCommit.current = onCommit;
  });

  const shown = draft ?? color;

  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next || (committed.current && sameColor(next, committed.current))) return;
    committed.current = next;
    latestCommit.current(toCssColor(next));
  };
  useEffect(() => () => flush(), []);

  /** Live preview now; persist once the pointer is up and the color has settled. */
  const change = (next: Rgba, immediate = false) => {
    setDraft(next);
    onPreview(toCssColor(next));
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (immediate) flush();
    else if (!dragging.current) timer.current = window.setTimeout(flush, COMMIT_DELAY_MS);
  };

  const commitNow = (next: Rgba) => {
    committed.current = null;
    change(next, true);
    // Outside the popover there is no draft to keep; show the stored value again.
    if (!open) setDraft(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next) {
      committed.current = color;
      setPrevious(color);
      const root = frameRoot?.();
      setFrameColors(root ? collectFrameColors(root) : []);
    } else {
      flush();
      setDraft(null);
    }
  };

  const startDrag = () => {
    dragging.current = true;
    const release = () => {
      dragging.current = false;
      if (pending.current) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, COMMIT_DELAY_MS);
      }
    };
    window.addEventListener("pointerup", release, { once: true, capture: true });
  };

  const submitHex = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const typed = resolveCssColor(/^[0-9a-f]{3,8}$/i.test(trimmed) ? `#${trimmed}` : trimmed);
    if (!typed) return;
    // A bare hex keeps the current opacity, which has its own field.
    const keepAlpha = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed) && shown;
    commitNow(keepAlpha ? { ...typed, a: shown.a } : typed);
  };

  /**
   * A colour typed in the picker's text field: kept as written when it is wider than sRGB
   * (so OKLCH and Display P3 survive), otherwise saved like any pick.
   */
  const commitText = (text: string) => {
    const wide = parseWideColor(text);
    if (wide && isOutOfSrgb(wide.linear)) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
      committed.current = null;
      onPreview(text);
      latestCommit.current(text);
      setDraft(null);
      return;
    }
    const typed = resolveCssColor(text);
    if (typed) commitNow(typed);
  };

  const pickFromScreen = async () => {
    const Constructor = eyeDropper();
    if (!Constructor) return;
    try {
      const result = await new Constructor().open();
      const picked = resolveCssColor(result.sRGBHex);
      if (picked) commitNow(picked);
    } catch {
      // Escape cancels the eyedropper; nothing changes.
    }
  };

  const alphaPercent = shown ? Math.round(shown.a * 100) : null;
  const opacityProps = {
    ariaLabel: t("workspace:canvasInspectorOpacityOf", { name: ariaLabel }),
    suffix: "%",
    unit: "%",
    min: 0,
    max: 100,
    value: alphaPercent,
    mixed,
    disabled: disabled || (!shown && !mixed),
    onPreview: (percent: number) => {
      const base = shown ?? FALLBACK_COLOR;
      onPreview(toCssColor({ ...base, a: percent / 100 }));
    },
  };
  const commitOpacity = (percent: number) => {
    const base = shown ?? FALLBACK_COLOR;
    commitNow({ ...base, a: Math.min(100, Math.max(0, percent)) / 100 });
  };
  const hasEyedropper = eyeDropper() !== null;

  return (
    <InspectorPropertyRow
      active={open}
      disabled={disabled}
      removeLabel={removeLabel}
      onRemove={onRemove}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          disabled={disabled}
          aria-label={t("workspace:canvasInspectorPickColor", { name: ariaLabel })}
          className={cn(
            "flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            open && SWATCH_RING_CLASS_NAME,
          )}
        >
          <ColorSwatch color={shown} mixed={mixed && !draft} />
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" sideOffset={12}>
          <div
            className="flex w-[26.5rem] flex-col gap-3"
            onKeyDown={(event) => {
              if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey)
                return;
              // The picker's keys: I picks from the screen, Enter closes.
              if (event.key.toLowerCase() === "i" && hasEyedropper) {
                event.preventDefault();
                void pickFromScreen();
              } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
                event.preventDefault();
                handleOpenChange(false);
              }
            }}
          >
            <div className="-my-1 flex items-center gap-1">
              <PopoverTitle className="min-w-0 flex-1 truncate text-ui font-medium">
                {ariaLabel}
              </PopoverTitle>
              {hasEyedropper ? (
                <IconButton
                  label={t("workspace:canvasInspectorEyedropper")}
                  tooltip={t("workspace:canvasInspectorEyedropper")}
                  onClick={() => void pickFromScreen()}
                >
                  <EyedropperIcon />
                </IconButton>
              ) : null}
              <IconButton
                label={t("workspace:canvasInspectorCloseColorPicker")}
                className="-me-1"
                onClick={() => handleOpenChange(false)}
              >
                <XIcon />
              </IconButton>
            </div>
            <div className="flex flex-col gap-2">
              <ColorPicker
                color={shown ?? FALLBACK_COLOR}
                previous={previous}
                clipped={clipped && draft === null}
                disabled={disabled}
                onChange={(next) => change(next)}
                onCommit={commitNow}
                onCommitText={commitText}
                onDragStart={startDrag}
              />
              <div className="flex gap-2">
                <div className={cn(INSPECTOR_FIELD_CLASS_NAME, "flex-1")}>
                  <HexInput
                    color={shown}
                    mixed={mixed && !draft}
                    ariaLabel={t("workspace:canvasInspectorHexOf", { name: ariaLabel })}
                    disabled={disabled}
                    onSubmit={submitHex}
                  />
                </div>
                <InspectorNumberField
                  {...opacityProps}
                  className="w-16 shrink-0"
                  onCommit={(input) => {
                    if (input.kind === "length") commitOpacity(input.value);
                  }}
                />
              </div>
            </div>
            {frameColors.length > 0 ? (
              <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <span className="text-ui-xs font-medium text-muted-foreground">
                  {t("workspace:canvasInspectorFrameColors")}
                </span>
                <div className="flex flex-wrap gap-1">
                  {frameColors.map((swatch) => {
                    const rgba = resolveCssColor(swatch);
                    const current = rgba !== null && shown !== null && sameColor(rgba, shown);
                    return (
                      <Tooltip key={swatch}>
                        <TooltipTrigger
                          render={
                            <Toggle
                              size="xs"
                              aria-label={swatch}
                              pressed={current}
                              onPressedChange={() => rgba && commitNow(rgba)}
                            />
                          }
                        >
                          <ColorSwatch color={rgba} />
                        </TooltipTrigger>
                        <TooltipPopup>{swatch}</TooltipPopup>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      <HexInput
        color={shown}
        mixed={mixed && !draft}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className="flex-1"
        onSubmit={submitHex}
      />
      <InspectorNumberField
        {...opacityProps}
        bare
        className="w-11 shrink-0 text-muted-foreground"
        inputClassName="text-end"
        onCommit={(input) => {
          if (input.kind !== "length") return;
          const base = shown ?? FALLBACK_COLOR;
          onCommit(toCssColor({ ...base, a: Math.min(100, Math.max(0, input.value)) / 100 }));
        }}
      />
      {trailing}
    </InspectorPropertyRow>
  );
}
