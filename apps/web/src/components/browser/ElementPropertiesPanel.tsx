// FILE: ElementPropertiesPanel.tsx
// Purpose: Floating live-editor controls for temporary element style previews.
// Layer: Browser editor UI

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  BROWSER_SYSTEM_FONT_OPTIONS,
  browserElementContextLabel,
  type BrowserElementEditorContext,
  type BrowserElementStylePatch,
  normalizeBrowserElementStylePatch,
} from "~/lib/browserEditorContext";
import type { BrowserStyleEditSourcePlan } from "~/lib/browserStyleSourceEdit";
import { browserStylePatchToCssText } from "~/lib/browserStylePreview";
import {
  cssColorToHexInput,
  eyeDropperConstructor,
  hexColorWithAlpha,
  parseCssColor,
} from "~/lib/cssColor";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useRafThrottledCallback } from "~/hooks/useRafThrottledCallback";
import { BROWSER_GLASS_SURFACE_CLASS_NAME } from "~/lib/glassSurface";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ColorPickerIcon,
  CopyIcon,
  SearchIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { BoxModelVisualizer } from "./BoxModelVisualizer";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";

type StylePatchKey = keyof BrowserElementStylePatch;
type PanelTab = "style" | "effects";
type EffectPatchKey = Extract<
  StylePatchKey,
  | "backgroundImage"
  | "backgroundPosition"
  | "backgroundSize"
  | "opacity"
  | "filter"
  | "animationDuration"
  | "animationTimingFunction"
  | "animationIterationCount"
>;

interface ElementPropertiesPanelProps {
  element: BrowserElementEditorContext;
  /**
   * Selector of the live page selection. Breadcrumb traversal moves the
   * selection while the panel stays frozen on `element`; the matching crumb is
   * highlighted so the traversal cursor stays visible.
   */
  selectedSelector?: string | undefined;
  initialPatch?: BrowserElementStylePatch | undefined;
  onPreviewPatch: (patch: BrowserElementStylePatch) => void;
  onAttachContext: (patch: BrowserElementStylePatch, manualOverride: boolean) => void;
  /** Resolves the source location without writing; rejects with a readable message. */
  onPlanSourceEdit: (patch: BrowserElementStylePatch) => Promise<BrowserStyleEditSourcePlan>;
  /** Writes the edit to source; rejects with a readable message. */
  onApplySourceEdit: (
    patch: BrowserElementStylePatch,
    plan: BrowserStyleEditSourcePlan,
  ) => Promise<void>;
  /** Re-selects a different element (breadcrumb navigation). */
  onSelectElement?: ((selector: string) => void) | undefined;
  onResetPreview: () => void;
  onClose: () => void;
  onDragHandlePointerDown?: ((event: ReactPointerEvent<HTMLDivElement>) => void) | undefined;
}

type SourceEditState =
  | { status: "idle" }
  | { status: "planning" }
  | { status: "confirm"; plan: BrowserStyleEditSourcePlan }
  | { status: "applying"; plan: BrowserStyleEditSourcePlan }
  | { status: "error"; message: string };

interface OptionItem {
  value: string;
  label?: string;
}

type OptionDisplayMode = "default" | "font";

interface NumericSpec {
  defaultValue: number;
  defaultUnit: string;
  sensitivity: number;
  step: number;
  precision: number;
  scrubStepPixels?: number;
  min?: number;
  max?: number;
  options?: readonly OptionItem[];
  /** Cycle-through units for the inline unit switcher. */
  units?: readonly string[];
}

const LENGTH_UNITS = ["px", "rem", "em", "%"] as const;

const FONT_STYLE_OPTIONS = [
  { value: "normal" },
  { value: "italic" },
  { value: "oblique" },
] as const;

const LINE_HEIGHT_OPTIONS = ["normal", "1", "1.1", "1.2", "1.4", "1.5", "1.75", "2"].map(
  (value) => ({ value }),
);

const TRACKING_OPTIONS = ["normal", "-0.05em", "-0.025em", "0px", "0.025em", "0.05em", "0.1em"].map(
  (value) => ({ value }),
);

const TEXT_ALIGN_OPTIONS = ["start", "left", "center", "right", "end", "justify"].map((value) => ({
  value,
}));

const SHADOW_OPTIONS = [
  { value: "none" },
  { value: "0 1px 2px rgba(0, 0, 0, 0.12)", label: "Soft" },
  { value: "0 8px 24px rgba(0, 0, 0, 0.18)", label: "Raised" },
  { value: "0 18px 60px rgba(0, 0, 0, 0.26)", label: "Floating" },
] as const;

const EFFECT_TIMING_OPTIONS = [
  { value: "linear" },
  { value: "ease" },
  { value: "ease-in" },
  { value: "ease-out" },
  { value: "ease-in-out" },
] as const;

const EFFECT_ITERATION_OPTIONS = [
  { value: "infinite" },
  { value: "1" },
  { value: "2" },
  { value: "3" },
] as const;

const EFFECT_SCALE_OPTIONS = [
  { value: "auto" },
  { value: "cover" },
  { value: "contain" },
  { value: "100% 100%" },
  { value: "200% 100%", label: "Shimmer" },
  { value: "200% 200%" },
  { value: "400% 400%" },
] as const;

const EFFECT_POSITION_OPTIONS = [
  { value: "center" },
  { value: "left top" },
  { value: "right bottom" },
  { value: "0% 50%" },
  { value: "50% 50%" },
  { value: "100% 50%" },
] as const;

const EFFECT_FILTER_OPTIONS = [
  { value: "none" },
  { value: "blur(4px)", label: "Blur" },
  { value: "brightness(1.15)", label: "Brighten" },
  { value: "contrast(1.2)", label: "Contrast" },
  { value: "grayscale(1)", label: "Grayscale" },
  { value: "saturate(1.4)", label: "Saturate" },
  { value: "hue-rotate(45deg)", label: "Hue shift" },
  {
    value: "drop-shadow(0 4px 12px rgba(0, 0, 0, 0.35))",
    label: "Drop shadow",
  },
] as const;

const EMPTY_BROWSER_EFFECTS: NonNullable<BrowserElementEditorContext["effects"]> = [];

/** Per-axis scrub behavior for parsed background-size/position components. */
const EFFECT_AXIS_SPEC: NumericSpec = {
  defaultValue: 0,
  defaultUnit: "%",
  sensitivity: 0.5,
  step: 1,
  precision: 2,
};

const EFFECT_ANGLE_SPEC: NumericSpec = {
  defaultValue: 90,
  defaultUnit: "deg",
  sensitivity: 0.5,
  step: 1,
  precision: 1,
};

/** Ratio-style filter args (brightness(1.15), saturate(1.4), grayscale(1)). */
const FILTER_RATIO_SPEC: NumericSpec = {
  defaultValue: 1,
  defaultUnit: "",
  sensitivity: 0.01,
  step: 0.05,
  precision: 2,
  min: 0,
};

const FILTER_FUNCTION_SPECS: Record<string, NumericSpec> = {
  blur: {
    defaultValue: 4,
    defaultUnit: "px",
    sensitivity: 0.15,
    step: 0.5,
    precision: 1,
    min: 0,
  },
  "hue-rotate": {
    defaultValue: 0,
    defaultUnit: "deg",
    sensitivity: 1,
    step: 1,
    precision: 0,
  },
};

/** Per-component scrub behavior for parsed box-shadow offsets and spread. */
const SHADOW_AXIS_SPEC: NumericSpec = {
  defaultValue: 0,
  defaultUnit: "px",
  sensitivity: 0.35,
  step: 1,
  precision: 1,
};

/** Blur radius cannot be negative. */
const SHADOW_BLUR_SPEC: NumericSpec = {
  ...SHADOW_AXIS_SPEC,
  min: 0,
};

const EFFECT_NUMERIC_SPECS: Record<"speed" | "opacity", NumericSpec> = {
  speed: {
    defaultValue: 1.5,
    defaultUnit: "s",
    sensitivity: -0.02,
    step: 0.05,
    precision: 2,
    min: 0.05,
    max: 20,
  },
  opacity: {
    defaultValue: 1,
    defaultUnit: "",
    sensitivity: 0.005,
    step: 0.01,
    precision: 2,
    min: 0,
    max: 1,
  },
};

const NUMERIC_SPECS: Record<
  Extract<
    StylePatchKey,
    | "fontSize"
    | "fontWeight"
    | "lineHeight"
    | "letterSpacing"
    | "padding"
    | "margin"
    | "borderWidth"
    | "borderRadius"
    | "opacity"
  >,
  NumericSpec
> = {
  fontSize: {
    defaultValue: 16,
    defaultUnit: "px",
    sensitivity: 0.35,
    step: 1,
    precision: 0,
    units: LENGTH_UNITS,
  },
  fontWeight: {
    defaultValue: 400,
    defaultUnit: "",
    sensitivity: 2,
    step: 100,
    precision: 0,
    scrubStepPixels: 12,
    // Valid font-weight range is 1-1000; 0 is invalid and silently ignored.
    min: 1,
    max: 900,
  },
  lineHeight: {
    defaultValue: 20,
    defaultUnit: "px",
    sensitivity: 0.35,
    step: 1,
    precision: 0,
    options: LINE_HEIGHT_OPTIONS,
  },
  letterSpacing: {
    defaultValue: 0,
    defaultUnit: "px",
    sensitivity: 0.035,
    step: 0.1,
    precision: 2,
    options: TRACKING_OPTIONS,
    units: ["px", "em", "rem"],
  },
  padding: {
    defaultValue: 0,
    defaultUnit: "px",
    sensitivity: 0.45,
    step: 1,
    precision: 0,
    units: LENGTH_UNITS,
  },
  margin: {
    defaultValue: 0,
    defaultUnit: "px",
    sensitivity: 0.45,
    step: 1,
    precision: 0,
    units: LENGTH_UNITS,
  },
  borderWidth: {
    defaultValue: 0,
    defaultUnit: "px",
    sensitivity: 0.2,
    step: 0.5,
    precision: 1,
    units: ["px", "rem", "em"],
  },
  borderRadius: {
    defaultValue: 0,
    defaultUnit: "px",
    sensitivity: 0.45,
    step: 1,
    precision: 0,
    units: LENGTH_UNITS,
  },
  opacity: {
    defaultValue: 1,
    defaultUnit: "",
    sensitivity: 0.005,
    step: 0.01,
    precision: 2,
    min: 0,
    max: 1,
  },
};

// px <-> rem/em conversion assumes the default 16px root font size; other unit
// pairs (e.g. anything involving %) keep the raw amount because the reference
// box is unknown here.
function convertAmountBetweenUnits(amount: number, fromUnit: string, toUnit: string): number {
  const pxFactor = (unit: string): number | null =>
    unit === "px" ? 1 : unit === "rem" || unit === "em" ? 16 : null;
  const from = pxFactor(fromUnit);
  const to = pxFactor(toUnit);
  if (from !== null && to !== null && from !== to) {
    return (amount * from) / to;
  }
  return amount;
}

function patchValue(
  element: BrowserElementEditorContext,
  patch: BrowserElementStylePatch,
  key: StylePatchKey,
): string {
  const style = element.style as Partial<Record<StylePatchKey, string>> | undefined;
  return patch[key] ?? style?.[key] ?? "";
}

function unquoteFontFamilyName(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function fontOptionDisplayName(value: string, label?: string): string {
  const cleanLabel = label
    ?.replace(/^Current:\s*/i, "")
    .replace(/\s+stack$/i, "")
    .trim();
  if (cleanLabel) {
    return cleanLabel;
  }
  const firstFamily = value.split(",")[0]?.trim();
  return firstFamily ? unquoteFontFamilyName(firstFamily) : value;
}

function displayValueForOption(value: string, options: readonly OptionItem[]): string {
  const option = options.find((item) => item.value === value);
  return fontOptionDisplayName(value, option?.label);
}

function controlClassName(isChanged: boolean): string {
  return cn(
    "h-7 min-h-7 rounded-md border border-black/10 bg-white/38 text-[11px] text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.035] dark:text-foreground dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
    isChanged &&
      "border-cyan-500/40 bg-cyan-300/16 dark:border-cyan-300/35 dark:bg-cyan-300/[0.08]",
  );
}

function uniqueOptions(currentValue: string, options: readonly OptionItem[]): OptionItem[] {
  const seen = new Set<string>();
  return [currentValue.trim() ? { value: currentValue.trim(), label: "Current" } : null, ...options]
    .filter((option): option is OptionItem => Boolean(option?.value.trim()))
    .filter((option) => {
      const key = option.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatNumber(value: number, precision: number): string {
  if (precision === 0) {
    return Math.round(value).toString();
  }
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

function clampNumber(value: number, min?: number, max?: number): number {
  return Math.min(
    max ?? Number.POSITIVE_INFINITY,
    Math.max(min ?? Number.NEGATIVE_INFINITY, value),
  );
}

function snapNumber(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function parseNumericValue(value: string, spec: NumericSpec): { amount: number; unit: string } {
  const trimmed = value.trim();
  if (trimmed === "bold") return { amount: 700, unit: "" };
  if (trimmed === "normal" && spec.defaultUnit === "") return { amount: 400, unit: "" };
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)([a-z%]*)/i);
  if (!match) return { amount: spec.defaultValue, unit: spec.defaultUnit };
  return {
    amount: Number(match[1]),
    unit: match[2] || spec.defaultUnit,
  };
}

function extractCssColors(value: string): string[] {
  return value.match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? [];
}

function replaceCssColorAtIndex(value: string, index: number, nextColor: string): string {
  let currentIndex = -1;
  return value.replace(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi, (match) => {
    currentIndex += 1;
    return currentIndex === index ? nextColor : match;
  });
}

function effectValue(
  effect: NonNullable<BrowserElementEditorContext["effects"]>[number],
  patch: BrowserElementStylePatch,
  name: EffectPatchKey,
): string {
  return patch[name] ?? effect[name] ?? "";
}

/** Splits a CSS value on top-level whitespace, keeping function args intact. */
function splitCssTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// Accepts complete amounts ("220%", "-100.832px") plus in-progress input
// ("-", "12.") so an axis field doesn't flip back to the plain text row and
// drop focus mid-keystroke. Pure keywords ("cover", "left") never match.
const CSS_AMOUNT_PATTERN = /^-?\.?$|^-?(?:\d+\.?\d*|\.\d*)[a-z%]*$/i;

/**
 * Parses a two-axis CSS value ("220% 100%", "-100.832% 0px", "50%") into
 * scrubbable tokens. Keyword values ("cover", "left top") return null so the
 * caller can fall back to a plain text input with presets.
 */
function parseCssAxisTokens(value: string): string[] | null {
  const tokens = splitCssTokens(value.trim());
  if (tokens.length < 1 || tokens.length > 2) {
    return null;
  }
  return tokens.every((token) => CSS_AMOUNT_PATTERN.test(token)) ? tokens : null;
}

const GRADIENT_ANGLE_PATTERN =
  /^(\s*(?:repeating-)?(?:linear|conic)-gradient\(\s*)(-?(?:\d+\.?\d*|\.\d+))deg/i;

/** Angle in degrees of a linear/conic gradient, or null when not angle-based. */
function cssGradientAngle(value: string): number | null {
  const match = value.match(GRADIENT_ANGLE_PATTERN);
  const amount = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  return Number.isFinite(amount) ? amount : null;
}

function cssGradientWithAngle(value: string, angle: number): string {
  return value.replace(GRADIENT_ANGLE_PATTERN, (_, prefix: string) => `${prefix}${angle}deg`);
}

const CSS_FUNCTION_TOKEN_PATTERN = /^([a-z-]+)\((.*)\)$/i;

interface CssFilterFunctionToken {
  /** Lowercased function name ("blur", "hue-rotate"). */
  name: string;
  /** Raw argument ("4px", "1.15"). */
  arg: string;
  /** Position in the full token list, for lossless rebuilds. */
  tokenIndex: number;
}

interface ParsedCssFilterList {
  tokens: string[];
  /** Functions with a single numeric argument; drop-shadow/url stay text-only. */
  functions: CssFilterFunctionToken[];
}

/**
 * Parses a CSS filter list ("blur(4px) brightness(1.15)") into per-function
 * scrubbable tokens. Functions with non-numeric arguments (drop-shadow, url)
 * are kept verbatim in `tokens` but excluded from `functions`.
 */
function parseCssFilterFunctions(value: string): ParsedCssFilterList | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") {
    return null;
  }
  const tokens = splitCssTokens(trimmed);
  const functions: CssFilterFunctionToken[] = [];
  for (const [tokenIndex, token] of tokens.entries()) {
    const match = CSS_FUNCTION_TOKEN_PATTERN.exec(token);
    if (!match) {
      return null;
    }
    const arg = (match[2] ?? "").trim();
    if (CSS_AMOUNT_PATTERN.test(arg)) {
      functions.push({ name: (match[1] ?? "").toLowerCase(), arg, tokenIndex });
    }
  }
  return functions.length > 0 ? { tokens, functions } : null;
}

function cssFilterWithFunctionArg(
  parsed: ParsedCssFilterList,
  fn: CssFilterFunctionToken,
  nextArg: string,
): string {
  return parsed.tokens
    .map((token, index) => (index === fn.tokenIndex ? `${fn.name}(${nextArg})` : token))
    .join(" ");
}

function filterFunctionSpec(name: string): NumericSpec {
  return FILTER_FUNCTION_SPECS[name] ?? FILTER_RATIO_SPEC;
}

function filterFunctionLabel(name: string): string {
  const readable = name.replace(/-/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

interface ParsedCssBoxShadow {
  inset: boolean;
  /** 2-4 length tokens: offset-x, offset-y, blur?, spread? */
  amounts: string[];
  color: string | null;
}

function cssValueHasTopLevelComma(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

/**
 * Parses a single box-shadow ("0 8px 24px rgba(0,0,0,0.18)", computed-style
 * order "rgba(...) 0px 8px 24px 0px", optional inset) into programmable parts.
 * Multi-shadow lists and unexpected keywords return null so the caller falls
 * back to the plain preset select.
 */
function parseCssBoxShadow(value: string): ParsedCssBoxShadow | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || cssValueHasTopLevelComma(trimmed)) {
    return null;
  }
  let inset = false;
  let color: string | null = null;
  const amounts: string[] = [];
  for (const token of splitCssTokens(trimmed)) {
    if (token.toLowerCase() === "inset") {
      inset = true;
      continue;
    }
    if (CSS_AMOUNT_PATTERN.test(token)) {
      amounts.push(token);
      continue;
    }
    if (color !== null) {
      return null;
    }
    color = token;
  }
  return amounts.length >= 2 && amounts.length <= 4 ? { inset, amounts, color } : null;
}

function formatCssBoxShadow(shadow: ParsedCssBoxShadow): string {
  return [shadow.inset ? "inset" : null, ...shadow.amounts, shadow.color]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function SearchableOptions({
  value,
  options,
  onSelect,
  onCancel,
  displayMode = "default",
}: {
  value: string;
  options: readonly OptionItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  displayMode?: OptionDisplayMode;
}) {
  const [query, setQuery] = useState("");
  const allOptions = useMemo(() => uniqueOptions(value, options), [options, value]);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return allOptions;
    return allOptions.filter((option) =>
      `${option.label ?? ""} ${option.value}`.toLowerCase().includes(normalizedQuery),
    );
  }, [allOptions, query]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    const selectedIndex = filteredOptions.findIndex((option) => option.value === value);
    setHighlightedIndex(Math.max(0, selectedIndex));
  }, [filteredOptions, value]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (filteredOptions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex(
        (current) => (current + direction + filteredOptions.length) % filteredOptions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selectedOption = filteredOptions[highlightedIndex] ?? filteredOptions[0];
      if (selectedOption) {
        onSelect(selectedOption.value);
      }
    }
  };

  return (
    <div className="w-64">
      <div className="border-b border-black/10 p-2 dark:border-white/10">
        <div className="flex h-7 items-center gap-2 rounded-md border border-black/10 bg-white/44 px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.52)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.05]">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            placeholder="Search values"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-950 outline-none placeholder:text-slate-500 dark:text-foreground dark:placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filteredOptions.length > 0 ? (
          filteredOptions.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] text-slate-950 transition hover:bg-white/48 dark:text-foreground dark:hover:bg-white/[0.07]",
                  isHighlighted && "bg-white/56 dark:bg-white/[0.07]",
                )}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => onSelect(option.value)}
              >
                <span
                  className="min-w-0 flex-1 truncate"
                  style={displayMode === "font" ? { fontFamily: option.value } : undefined}
                >
                  {displayMode === "font" ? (
                    fontOptionDisplayName(option.value, option.label)
                  ) : (
                    <>
                      {option.label ? (
                        <span className="mr-2 text-muted-foreground">{option.label}</span>
                      ) : null}
                      {option.value}
                    </>
                  )}
                </span>
                {isSelected ? (
                  <CheckIcon className="size-3 shrink-0 text-cyan-500 dark:text-cyan-200" />
                ) : null}
              </button>
            );
          })
        ) : (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No values found
          </div>
        )}
      </div>
    </div>
  );
}

function OptionPopover({
  value,
  options,
  onSelect,
  children,
  triggerClassName,
  displayMode = "default",
}: {
  value: string;
  options: readonly OptionItem[];
  onSelect: (value: string) => void;
  children: ReactNode;
  triggerClassName?: string;
  displayMode?: OptionDisplayMode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/35",
              triggerClassName,
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        sideOffset={6}
        data-browser-properties-popover="true"
        className="overflow-hidden border-black/10 bg-white/54 p-0 text-slate-950 shadow-[0_18px_54px_rgba(15,23,42,0.2),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/78 dark:text-foreground dark:shadow-[0_18px_50px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.06)] [&_[data-slot=popover-viewport]]:p-0"
      >
        <SearchableOptions
          value={value}
          options={options}
          onSelect={(nextValue) => {
            onSelect(nextValue);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
          displayMode={displayMode}
        />
      </PopoverPopup>
    </Popover>
  );
}

function FieldClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-cyan-600 transition hover:bg-cyan-400/15 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-100"
      title="Reset to page value"
      onClick={onClear}
    >
      <XIcon className="size-2.5" />
      <span className="sr-only">Reset to page value</span>
    </button>
  );
}

function FieldShell({
  label,
  children,
  scrub,
  onClear,
}: {
  label: string;
  children: ReactNode;
  scrub?: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  };
  /** Rendered when the field diverges from the page value; removes the override. */
  onClear?: (() => void) | undefined;
}) {
  const labelClassName = cn(
    "min-w-0 truncate text-left text-[10px] font-medium uppercase text-muted-foreground",
    scrub && "cursor-ew-resize select-none hover:text-foreground",
  );
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        {scrub ? (
          <button
            type="button"
            className={labelClassName}
            title="Drag horizontally to adjust"
            onPointerDown={scrub.onPointerDown}
            onPointerMove={scrub.onPointerMove}
            onPointerUp={scrub.onPointerUp}
            onPointerCancel={scrub.onPointerUp}
          >
            {label}
          </button>
        ) : (
          <span className={labelClassName}>{label}</span>
        )}
        {onClear ? <FieldClearButton onClear={onClear} /> : null}
      </div>
      {children}
    </div>
  );
}

function SelectRow({
  element,
  patch,
  name,
  label,
  options,
  onChange,
  onClear,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: StylePatchKey;
  label: string;
  options: readonly OptionItem[];
  onChange: (name: StylePatchKey, value: string) => void;
  onClear: (name: StylePatchKey) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name] !== undefined;
  const isFontFamily = name === "fontFamily";
  return (
    <FieldShell label={label} onClear={changed ? () => onClear(name) : undefined}>
      <OptionPopover
        value={value}
        options={options}
        onSelect={(nextValue) => onChange(name, nextValue)}
        displayMode={isFontFamily ? "font" : "default"}
        triggerClassName={cn(
          controlClassName(changed),
          "w-full justify-between px-2 text-left transition hover:bg-accent/70 dark:hover:bg-white/[0.07]",
        )}
      >
        <span
          className="min-w-0 flex-1 truncate"
          style={isFontFamily && value ? { fontFamily: value } : undefined}
        >
          {value ? (isFontFamily ? displayValueForOption(value, options) : value) : "Select"}
        </span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </OptionPopover>
    </FieldShell>
  );
}

function useNumericDraftScrub(input: {
  value: string;
  spec: NumericSpec;
  onChange: (value: string) => void;
}) {
  const { value, spec, onChange } = input;
  const [draftValue, setDraftValue] = useState(value);
  const scrubRef = useRef<{
    pointerId: number;
    startX: number;
    startAmount: number;
    unit: string;
  } | null>(null);
  const lastScrubValueRef = useRef("");

  useEffect(() => {
    if (!scrubRef.current) {
      setDraftValue(value);
    }
  }, [value]);

  const updateFromDelta = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - scrub.startX;
    const rawValue =
      spec.scrubStepPixels && spec.scrubStepPixels > 0
        ? scrub.startAmount + Math.round(deltaX / spec.scrubStepPixels) * spec.step
        : scrub.startAmount + deltaX * spec.sensitivity;
    const nextAmount = clampNumber(snapNumber(rawValue, spec.step), spec.min, spec.max);
    const nextValue = `${formatNumber(nextAmount, spec.precision)}${scrub.unit}`;
    if (lastScrubValueRef.current === nextValue) return;
    lastScrubValueRef.current = nextValue;
    setDraftValue(nextValue);
    onChange(nextValue);
  };

  const scrubHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const parsed = parseNumericValue(draftValue || value, spec);
      scrubRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startAmount: parsed.amount,
        unit: parsed.unit,
      };
      lastScrubValueRef.current = draftValue || value;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: updateFromDelta,
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (scrubRef.current?.pointerId === event.pointerId) {
        scrubRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }
    },
  };

  return { draftValue, scrubHandlers, setDraftValue };
}

function NumericRow({
  element,
  patch,
  name,
  label,
  spec,
  onChange,
  onClear,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: StylePatchKey;
  label: string;
  spec: NumericSpec;
  onChange: (name: StylePatchKey, value: string) => void;
  onClear: (name: StylePatchKey) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name]?.trim().length ? true : false;
  const { draftValue, scrubHandlers, setDraftValue } = useNumericDraftScrub({
    value,
    spec,
    onChange: (nextValue) => onChange(name, nextValue),
  });
  const parsedDraft = parseNumericValue(draftValue || value, spec);
  const activeUnit = parsedDraft.unit || spec.defaultUnit;

  const cycleUnit = () => {
    const units = spec.units;
    if (!units || units.length === 0) return;
    const nextUnit = units[(units.indexOf(activeUnit) + 1) % units.length];
    if (!nextUnit || nextUnit === activeUnit) return;
    const nextAmount = convertAmountBetweenUnits(parsedDraft.amount, activeUnit, nextUnit);
    const precision =
      nextUnit === "rem" || nextUnit === "em" ? Math.max(spec.precision, 3) : spec.precision;
    const nextValue = `${formatNumber(nextAmount, precision)}${nextUnit}`;
    setDraftValue(nextValue);
    onChange(name, nextValue);
  };

  return (
    <FieldShell
      label={label}
      scrub={scrubHandlers}
      onClear={changed ? () => onClear(name) : undefined}
    >
      <div className={cn("flex min-w-0 items-center overflow-hidden", controlClassName(changed))}>
        <Input
          size="sm"
          value={draftValue}
          nativeInput
          className="min-h-0 flex-1 border-0 bg-transparent"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const nextValue = event.target.value;
            setDraftValue(nextValue);
            onChange(name, nextValue);
          }}
        />
        {spec.units ? (
          <button
            type="button"
            className="mr-0.5 h-5 shrink-0 rounded px-1 text-[9px] font-medium uppercase text-muted-foreground transition hover:bg-accent/70 hover:text-foreground dark:hover:bg-white/[0.08]"
            title="Switch unit"
            onClick={cycleUnit}
          >
            {activeUnit || "—"}
          </button>
        ) : null}
        {spec.options ? (
          <OptionPopover
            value={draftValue}
            options={spec.options}
            onSelect={(nextValue) => {
              setDraftValue(nextValue);
              onChange(name, nextValue);
            }}
            triggerClassName="mr-1 size-5 shrink-0 justify-center rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <ChevronDownIcon className="size-3" />
          </OptionPopover>
        ) : null}
      </div>
    </FieldShell>
  );
}

function EyeDropperButton({ onPick }: { onPick: (hex: string) => void }) {
  const EyeDropper = useMemo(eyeDropperConstructor, []);
  if (!EyeDropper) {
    return null;
  }
  return (
    <button
      type="button"
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground dark:hover:bg-white/[0.08]"
      title="Pick a color from the screen"
      onClick={() => {
        // User dismissal (Escape) rejects; that is a no-op, not an error.
        void new EyeDropper()
          .open()
          .then((result) => onPick(result.sRGBHex))
          .catch(() => undefined);
      }}
    >
      <ColorPickerIcon className="size-3" />
      <span className="sr-only">Pick a color from the screen</span>
    </button>
  );
}

function ColorField({
  element,
  patch,
  name,
  label,
  onChange,
  onClear,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: Extract<StylePatchKey, "color" | "backgroundColor" | "borderColor">;
  label: string;
  onChange: (name: StylePatchKey, value: string) => void;
  onClear: (name: StylePatchKey) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name]?.trim().length ? true : false;
  const parsed = useMemo(() => parseCssColor(value), [value]);
  // Swatch picks emit 8-digit hex when the current value is translucent so
  // existing alpha survives a hue change. Dragging inside the native picker
  // fires input events faster than the display refreshes, so picks are
  // coalesced to one patch update per frame to keep the drag responsive.
  const pickColor = useRafThrottledCallback((hex: string) =>
    onChange(name, hexColorWithAlpha(hex, parsed?.alpha ?? 1)),
  );
  return (
    <label className="space-y-1">
      <span className="flex items-center gap-0.5 text-[10px] font-medium uppercase text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        {changed ? <FieldClearButton onClear={() => onClear(name)} /> : null}
      </span>
      <div className={cn("flex h-8 items-center gap-1.5 px-2", controlClassName(changed))}>
        <input
          type="color"
          value={parsed?.hex ?? "#000000"}
          className="size-5 shrink-0 rounded border-0 bg-transparent p-0"
          onChange={(event) => pickColor(event.target.value)}
        />
        <Input
          size="sm"
          value={value}
          nativeInput
          className="min-h-0 flex-1 border-0 bg-transparent px-0 text-[11px]"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(name, event.target.value)}
        />
        <EyeDropperButton onPick={pickColor} />
      </div>
    </label>
  );
}

function EffectTextRow({
  label,
  value,
  changed,
  options,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  changed: boolean;
  /** Optional presets surfaced through the shared searchable popover. */
  options?: readonly OptionItem[] | undefined;
  onChange: (value: string) => void;
  onClear?: (() => void) | undefined;
}) {
  return (
    <FieldShell label={label} onClear={changed && onClear ? onClear : undefined}>
      <div className={cn("flex min-w-0 items-center overflow-hidden", controlClassName(changed))}>
        <Input
          size="sm"
          value={value}
          nativeInput
          className="min-h-0 flex-1 border-0 bg-transparent"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
        {options ? (
          <OptionPopover
            value={value}
            options={options}
            onSelect={onChange}
            triggerClassName="mr-1 size-5 shrink-0 justify-center rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <ChevronDownIcon className="size-3" />
          </OptionPopover>
        ) : null}
      </div>
    </FieldShell>
  );
}

function EffectSelectRow({
  label,
  value,
  changed,
  options,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  changed: boolean;
  options: readonly OptionItem[];
  onChange: (value: string) => void;
  onClear?: (() => void) | undefined;
}) {
  return (
    <FieldShell label={label} onClear={changed && onClear ? onClear : undefined}>
      <OptionPopover
        value={value}
        options={options}
        onSelect={onChange}
        triggerClassName={cn(
          controlClassName(changed),
          "w-full justify-between px-2 text-left transition hover:bg-accent/70 dark:hover:bg-white/[0.07]",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{value || "Select"}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </OptionPopover>
    </FieldShell>
  );
}

function EffectNumericRow({
  label,
  value,
  changed,
  spec,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  changed: boolean;
  spec: NumericSpec;
  onChange: (value: string) => void;
  onClear?: (() => void) | undefined;
}) {
  const { draftValue, scrubHandlers, setDraftValue } = useNumericDraftScrub({
    value,
    spec,
    onChange,
  });

  return (
    <FieldShell
      label={label}
      scrub={scrubHandlers}
      onClear={changed && onClear ? onClear : undefined}
    >
      <Input
        size="sm"
        value={draftValue}
        nativeInput
        className={cn("min-h-0 border-0 bg-transparent", controlClassName(changed))}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const nextValue = event.target.value;
          setDraftValue(nextValue);
          onChange(nextValue);
        }}
      />
    </FieldShell>
  );
}

/** One scrubbable component of a multi-value CSS property ("220%" of "220% 100%"). */
function AxisNumericInput({
  axisLabel,
  token,
  spec = EFFECT_AXIS_SPEC,
  onChangeToken,
}: {
  axisLabel: string;
  token: string;
  spec?: NumericSpec;
  onChangeToken: (token: string) => void;
}) {
  const { draftValue, scrubHandlers, setDraftValue } = useNumericDraftScrub({
    value: token,
    spec,
    onChange: onChangeToken,
  });
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <button
        type="button"
        className="shrink-0 cursor-ew-resize select-none px-1 text-[9px] font-medium uppercase text-muted-foreground hover:text-foreground"
        title="Drag horizontally to adjust"
        onPointerDown={scrubHandlers.onPointerDown}
        onPointerMove={scrubHandlers.onPointerMove}
        onPointerUp={scrubHandlers.onPointerUp}
        onPointerCancel={scrubHandlers.onPointerUp}
      >
        {axisLabel}
      </button>
      <Input
        size="sm"
        value={draftValue}
        nativeInput
        className="min-h-0 min-w-0 flex-1 border-0 bg-transparent px-1"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const nextValue = event.target.value;
          setDraftValue(nextValue);
          onChangeToken(nextValue);
        }}
      />
    </div>
  );
}

/**
 * One gradient color stop swatch. Dragging the native picker is coalesced to
 * one gradient rebuild per frame so the drag stays smooth.
 */
function EffectColorStopSwatch({
  color,
  title,
  onChangeColor,
}: {
  color: string;
  title: string;
  onChangeColor: (nextColor: string) => void;
}) {
  const changeColor = useRafThrottledCallback(onChangeColor);
  return (
    <label
      className="group relative flex size-7 items-center justify-center rounded-md border border-black/10 bg-white/42 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] ring-1 ring-black/10 transition hover:border-slate-500/30 dark:border-white/10 dark:bg-black/20 dark:ring-black/20 dark:hover:border-white/25"
      title={title}
    >
      <span
        className="size-4 rounded-[4px] border border-white/25 shadow-inner"
        style={{ background: color }}
      />
      <input
        type="color"
        value={cssColorToHexInput(color)}
        className="absolute inset-0 cursor-pointer opacity-0"
        onInput={(event) => changeColor(event.currentTarget.value)}
      />
    </label>
  );
}

/**
 * Programmable box-shadow controls: when the current value is a single shadow
 * its offsets, blur/spread, and tint become scrubbable inputs; multi-shadow
 * lists render nothing and leave the preset select as the only control.
 */
function BoxShadowEditor({
  element,
  patch,
  onChange,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  onChange: (name: StylePatchKey, value: string) => void;
}) {
  const value = patchValue(element, patch, "boxShadow");
  const parsed = useMemo(() => parseCssBoxShadow(value), [value]);
  const changed = patch.boxShadow !== undefined;
  const parsedColor = useMemo(
    () => (parsed?.color ? parseCssColor(parsed.color) : null),
    [parsed?.color],
  );
  const pickShadowColor = useRafThrottledCallback((hex: string) => {
    if (!parsed?.color) return;
    onChange(
      "boxShadow",
      formatCssBoxShadow({ ...parsed, color: hexColorWithAlpha(hex, parsedColor?.alpha ?? 1) }),
    );
  });
  if (!parsed) {
    return null;
  }
  const changeAmount = (index: number, nextToken: string) => {
    onChange(
      "boxShadow",
      formatCssBoxShadow({
        ...parsed,
        amounts: parsed.amounts.map((amount, i) => (i === index ? nextToken : amount)),
      }),
    );
  };
  return (
    <>
      <FieldShell label="Offset">
        <div className={cn("flex min-w-0 items-center overflow-hidden", controlClassName(changed))}>
          <AxisNumericInput
            axisLabel="X"
            spec={SHADOW_AXIS_SPEC}
            token={parsed.amounts[0] ?? "0px"}
            onChangeToken={(nextToken) => changeAmount(0, nextToken)}
          />
          <AxisNumericInput
            axisLabel="Y"
            spec={SHADOW_AXIS_SPEC}
            token={parsed.amounts[1] ?? "0px"}
            onChangeToken={(nextToken) => changeAmount(1, nextToken)}
          />
        </div>
      </FieldShell>
      {parsed.amounts.length >= 3 ? (
        <FieldShell label="Blur">
          <div
            className={cn("flex min-w-0 items-center overflow-hidden", controlClassName(changed))}
          >
            <AxisNumericInput
              axisLabel={parsed.amounts.length >= 4 ? "B" : "·"}
              spec={SHADOW_BLUR_SPEC}
              token={parsed.amounts[2] ?? "0px"}
              onChangeToken={(nextToken) => changeAmount(2, nextToken)}
            />
            {parsed.amounts.length >= 4 ? (
              <AxisNumericInput
                axisLabel="S"
                spec={SHADOW_AXIS_SPEC}
                token={parsed.amounts[3] ?? "0px"}
                onChangeToken={(nextToken) => changeAmount(3, nextToken)}
              />
            ) : null}
          </div>
        </FieldShell>
      ) : null}
      {parsed.color ? (
        <FieldShell label="Tint">
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-hidden px-2",
              controlClassName(changed),
            )}
          >
            <input
              type="color"
              value={parsedColor?.hex ?? "#000000"}
              className="size-4 shrink-0 rounded border-0 bg-transparent p-0"
              onChange={(event) => pickShadowColor(event.target.value)}
            />
            <span className="min-w-0 flex-1 truncate text-[11px]" title={parsed.color}>
              {parsed.color}
            </span>
          </div>
        </FieldShell>
      ) : null}
    </>
  );
}

/**
 * Multi-value effect field ("220% 100%", "-100.832% 0px"): numeric values get
 * per-axis scrubbable inputs; keyword values ("cover", "left top") fall back to
 * the plain text row with presets.
 */
function EffectVectorRow({
  label,
  value,
  changed,
  options,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  changed: boolean;
  options?: readonly OptionItem[] | undefined;
  onChange: (value: string) => void;
  onClear?: (() => void) | undefined;
}) {
  const tokens = parseCssAxisTokens(value);
  if (!tokens) {
    return (
      <EffectTextRow
        label={label}
        value={value}
        changed={changed}
        options={options}
        onChange={onChange}
        onClear={onClear}
      />
    );
  }
  const changeToken = (index: number, nextToken: string) => {
    onChange(tokens.map((token, i) => (i === index ? nextToken : token)).join(" "));
  };
  return (
    <FieldShell label={label} onClear={changed && onClear ? onClear : undefined}>
      <div className={cn("flex min-w-0 items-center overflow-hidden", controlClassName(changed))}>
        {tokens.map((token, index) => (
          <AxisNumericInput
            key={`${label}-axis-${index}`}
            axisLabel={tokens.length > 1 ? (index === 0 ? "X" : "Y") : "·"}
            token={token}
            onChangeToken={(nextToken) => changeToken(index, nextToken)}
          />
        ))}
        {options ? (
          <OptionPopover
            value={value}
            options={options}
            onSelect={onChange}
            triggerClassName="mr-1 size-5 shrink-0 justify-center rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <ChevronDownIcon className="size-3" />
          </OptionPopover>
        ) : null}
      </div>
    </FieldShell>
  );
}

export const ElementPropertiesPanel = memo(function ElementPropertiesPanel({
  element,
  selectedSelector,
  initialPatch,
  onPreviewPatch,
  onAttachContext,
  onPlanSourceEdit,
  onApplySourceEdit,
  onSelectElement,
  onResetPreview,
  onClose,
  onDragHandlePointerDown,
}: ElementPropertiesPanelProps) {
  const [draftPatch, setDraftPatch] = useState<BrowserElementStylePatch>(initialPatch ?? {});
  const [manualOverride, setManualOverride] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTab>("style");
  const [activeEffectIndex, setActiveEffectIndex] = useState(0);
  const [sourceEdit, setSourceEdit] = useState<SourceEditState>({
    status: "idle",
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const elementKey = useMemo(
    () => `${element.url}\u0000${element.selector}\u0000${element.tagName}`,
    [element.selector, element.tagName, element.url],
  );
  const normalizedPatch = useMemo(
    () => normalizeBrowserElementStylePatch(draftPatch),
    [draftPatch],
  );
  const changedCount = Object.keys(normalizedPatch).length;
  const elementLabel = useMemo(() => browserElementContextLabel(element), [element]);
  const breadcrumb = useMemo(() => [...(element.ancestors ?? [])].reverse(), [element.ancestors]);
  const effects = element.effects ?? EMPTY_BROWSER_EFFECTS;
  const activeEffect =
    effects[Math.min(activeEffectIndex, Math.max(0, effects.length - 1))] ?? null;
  const activeEffectGradient = useMemo(
    () => (activeEffect ? effectValue(activeEffect, draftPatch, "backgroundImage") : ""),
    [activeEffect, draftPatch],
  );
  const activeEffectColors = useMemo(
    () => extractCssColors(activeEffectGradient).slice(0, 4),
    [activeEffectGradient],
  );
  const activeEffectGradientAngle = useMemo(
    () => cssGradientAngle(activeEffectGradient),
    [activeEffectGradient],
  );
  const activeEffectFilter = useMemo(
    () => (activeEffect ? effectValue(activeEffect, draftPatch, "filter") : ""),
    [activeEffect, draftPatch],
  );
  const activeEffectFilterFunctions = useMemo(
    () => parseCssFilterFunctions(activeEffectFilter),
    [activeEffectFilter],
  );
  const fontFamilyOptions = useMemo(
    () =>
      element.availableFonts && element.availableFonts.length > 0
        ? element.availableFonts
        : BROWSER_SYSTEM_FONT_OPTIONS,
    [element.availableFonts],
  );

  // The style patch carries a single target (`effectTarget` ⇒ ::before/::after,
  // otherwise the element itself), so switching between base-element edits and
  // effect edits restarts the patch for the new target. Merging across targets
  // would misroute values — e.g. a color tweak landing on ::before.
  const setPatchValue = useCallback((name: StylePatchKey, value: string) => {
    setDraftPatch((current) =>
      current.effectTarget !== undefined ? { [name]: value } : { ...current, [name]: value },
    );
  }, []);

  // Removes a single override so the field falls back to the page value.
  const clearPatchValue = useCallback((name: StylePatchKey) => {
    setDraftPatch((current) => {
      if (current[name] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[name];
      return next;
    });
  }, []);

  const setEffectPatchValue = useCallback(
    (name: EffectPatchKey, value: string) => {
      if (!activeEffect) return;
      setDraftPatch((current) =>
        current.effectTarget === activeEffect.source
          ? { ...current, [name]: value }
          : { effectTarget: activeEffect.source, [name]: value },
      );
    },
    [activeEffect],
  );

  useEffect(() => {
    setDraftPatch(initialPatch ?? {});
    setManualOverride(false);
    setActiveEffectIndex(0);
    setSourceEdit({ status: "idle" });
  }, [elementKey, initialPatch]);

  // A planned source edit is only valid for the exact patch it was computed
  // from; any further tweak invalidates the pending confirmation.
  const patchKey = useMemo(() => JSON.stringify(normalizedPatch), [normalizedPatch]);
  useEffect(() => {
    setSourceEdit((current) => (current.status === "idle" ? current : { status: "idle" }));
  }, [patchKey]);

  const beginSourceEdit = useCallback(() => {
    setSourceEdit({ status: "planning" });
    void onPlanSourceEdit(draftPatch)
      .then((plan) => setSourceEdit({ status: "confirm", plan }))
      .catch((error: unknown) =>
        setSourceEdit({
          status: "error",
          message: error instanceof Error ? error.message : "Could not plan the source edit.",
        }),
      );
  }, [draftPatch, onPlanSourceEdit]);

  const confirmSourceEdit = useCallback(
    (plan: BrowserStyleEditSourcePlan) => {
      setSourceEdit({ status: "applying", plan });
      void onApplySourceEdit(draftPatch, plan)
        .then(() => setSourceEdit({ status: "idle" }))
        .catch((error: unknown) =>
          setSourceEdit({
            status: "error",
            message: error instanceof Error ? error.message : "Could not apply the source edit.",
          }),
        );
    },
    [draftPatch, onApplySourceEdit],
  );

  useEffect(() => {
    if (activeEffectIndex >= effects.length) {
      setActiveEffectIndex(Math.max(0, effects.length - 1));
    }
  }, [activeEffectIndex, effects.length]);

  useEffect(() => {
    onPreviewPatch(normalizedPatch);
  }, [normalizedPatch, onPreviewPatch]);

  return (
    <div
      className={cn(
        BROWSER_GLASS_SURFACE_CLASS_NAME,
        "max-h-[min(42rem,calc(100vh-2rem))] w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl p-2.5 text-slate-950 dark:text-foreground",
      )}
    >
      <div
        className={cn("mb-2 flex items-start gap-3", onDragHandlePointerDown && "cursor-move")}
        onPointerDown={onDragHandlePointerDown}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <div
              className="min-w-0 truncate font-mono text-xs font-semibold"
              title={element.selector}
            >
              {elementLabel}
            </div>
            <div className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {Math.round(element.rect.width)} × {Math.round(element.rect.height)}
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">Element properties</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
          <span className="sr-only">Close properties</span>
        </Button>
      </div>

      {breadcrumb.length > 0 ? (
        <div className="mb-2.5 flex items-center overflow-x-auto whitespace-nowrap rounded-md border border-black/10 bg-white/30 px-1.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] [scrollbar-width:none] dark:border-white/10 dark:bg-white/[0.03] [&::-webkit-scrollbar]:hidden">
          {breadcrumb.map((ancestor, index) => {
            const isSelectionCursor = selectedSelector === ancestor.selector;
            return (
              <span key={`${ancestor.selector}-${index}`} className="flex shrink-0 items-center">
                <button
                  type="button"
                  className={cn(
                    "rounded px-1 py-0.5 font-mono text-[10px] transition",
                    isSelectionCursor
                      ? "bg-cyan-400/14 text-cyan-700 dark:bg-cyan-300/[0.14] dark:text-cyan-100"
                      : "text-muted-foreground",
                    onSelectElement &&
                      !isSelectionCursor &&
                      "hover:bg-slate-950/10 hover:text-foreground dark:hover:bg-white/[0.09]",
                  )}
                  title={ancestor.selector}
                  disabled={!onSelectElement}
                  onClick={() => onSelectElement?.(ancestor.selector)}
                >
                  {ancestor.label}
                </button>
                <ChevronRightIcon className="size-2.5 shrink-0 text-muted-foreground/60" />
              </span>
            );
          })}
          {(() => {
            // Without a diverged selection the panel's own element is the cursor.
            const elementIsSelectionCursor =
              !selectedSelector || selectedSelector === element.selector;
            return (
              <button
                type="button"
                className={cn(
                  "shrink-0 rounded px-1 py-0.5 font-mono text-[10px] transition",
                  elementIsSelectionCursor
                    ? "bg-cyan-400/14 text-cyan-700 dark:bg-cyan-300/[0.14] dark:text-cyan-100"
                    : "text-muted-foreground",
                  onSelectElement &&
                    !elementIsSelectionCursor &&
                    "hover:bg-slate-950/10 hover:text-foreground dark:hover:bg-white/[0.09]",
                )}
                title={element.selector}
                disabled={!onSelectElement || elementIsSelectionCursor}
                onClick={() => onSelectElement?.(element.selector)}
              >
                {elementLabel}
              </button>
            );
          })()}
        </div>
      ) : null}

      <div className="mb-2.5 grid grid-cols-2 rounded-md border border-black/10 bg-white/30 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.52)] dark:border-white/10 dark:bg-white/[0.03]">
        {(["style", "effects"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={cn(
              "h-6 rounded-[5px] text-[10px] font-medium capitalize text-muted-foreground transition",
              activeTab === tab &&
                "bg-white/66 text-slate-950 shadow-sm dark:bg-white/[0.08] dark:text-foreground",
            )}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "style" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <ColorField
              element={element}
              patch={draftPatch}
              name="color"
              label="Text"
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <ColorField
              element={element}
              patch={draftPatch}
              name="backgroundColor"
              label="Background"
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">
              Typography
            </div>
            <SelectRow
              element={element}
              patch={draftPatch}
              name="fontFamily"
              label="Family"
              options={fontFamilyOptions}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="fontSize"
              label="Size"
              spec={NUMERIC_SPECS.fontSize}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="fontWeight"
              label="Weight"
              spec={NUMERIC_SPECS.fontWeight}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="fontStyle"
              label="Style"
              options={FONT_STYLE_OPTIONS}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="lineHeight"
              label="Line"
              spec={NUMERIC_SPECS.lineHeight}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="letterSpacing"
              label="Tracking"
              spec={NUMERIC_SPECS.letterSpacing}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="textAlign"
              label="Align"
              options={TEXT_ALIGN_OPTIONS}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">Box</div>
            <BoxModelVisualizer element={element} patch={draftPatch} onChange={setPatchValue} />
            <ColorField
              element={element}
              patch={draftPatch}
              name="borderColor"
              label="Border"
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <div className="pt-1.5">
              <NumericRow
                element={element}
                patch={draftPatch}
                name="padding"
                label="Padding"
                spec={NUMERIC_SPECS.padding}
                onChange={setPatchValue}
                onClear={clearPatchValue}
              />
            </div>
            <NumericRow
              element={element}
              patch={draftPatch}
              name="margin"
              label="Margin"
              spec={NUMERIC_SPECS.margin}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="borderWidth"
              label="Border"
              spec={NUMERIC_SPECS.borderWidth}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="borderRadius"
              label="Radius"
              spec={NUMERIC_SPECS.borderRadius}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="boxShadow"
              label="Shadow"
              options={SHADOW_OPTIONS}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
            <BoxShadowEditor element={element} patch={draftPatch} onChange={setPatchValue} />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="opacity"
              label="Opacity"
              spec={NUMERIC_SPECS.opacity}
              onChange={setPatchValue}
              onClear={clearPatchValue}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2.5">
          {activeEffect ? (
            <>
              <div className="rounded-md border border-black/10 bg-white/30 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold capitalize">{activeEffect.kind}</div>
                    <div className="truncate text-[9px] text-muted-foreground">
                      {activeEffect.label} · {activeEffect.animationName || "no animation name"}
                    </div>
                  </div>
                  {effects.length > 1 ? (
                    <div className="flex items-center gap-1">
                      {effects.map((effect, index) => (
                        <button
                          key={`${effect.source}-${index}`}
                          type="button"
                          className={cn(
                            "h-5 rounded-[5px] px-1.5 text-[9px] text-muted-foreground transition",
                            index === activeEffectIndex &&
                              "bg-cyan-400/14 text-cyan-700 dark:bg-cyan-300/[0.14] dark:text-cyan-100",
                          )}
                          onClick={() => setActiveEffectIndex(index)}
                        >
                          {effect.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              {activeEffectColors.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-[10px] font-medium uppercase text-muted-foreground">
                    Color scheme
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-black/10 bg-white/30 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:border-white/10 dark:bg-white/[0.03]">
                    {activeEffectColors.map((color, index) => (
                      <EffectColorStopSwatch
                        key={`${activeEffect.source}-color-${index}`}
                        color={color}
                        title={`Color stop ${index + 1}`}
                        onChangeColor={(nextColor) =>
                          setEffectPatchValue(
                            "backgroundImage",
                            replaceCssColorAtIndex(activeEffectGradient, index, nextColor),
                          )
                        }
                      />
                    ))}
                    <div className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
                      {activeEffectColors.length} stops
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Motion
                </div>
                <EffectNumericRow
                  label="Speed"
                  value={effectValue(activeEffect, draftPatch, "animationDuration")}
                  changed={draftPatch.animationDuration !== undefined}
                  spec={EFFECT_NUMERIC_SPECS.speed}
                  onChange={(value) => setEffectPatchValue("animationDuration", value)}
                  onClear={() => clearPatchValue("animationDuration")}
                />
                <EffectSelectRow
                  label="Timing"
                  value={effectValue(activeEffect, draftPatch, "animationTimingFunction")}
                  changed={draftPatch.animationTimingFunction !== undefined}
                  options={EFFECT_TIMING_OPTIONS}
                  onChange={(value) => setEffectPatchValue("animationTimingFunction", value)}
                  onClear={() => clearPatchValue("animationTimingFunction")}
                />
                <EffectSelectRow
                  label="Repeat"
                  value={effectValue(activeEffect, draftPatch, "animationIterationCount")}
                  changed={draftPatch.animationIterationCount !== undefined}
                  options={EFFECT_ITERATION_OPTIONS}
                  onChange={(value) => setEffectPatchValue("animationIterationCount", value)}
                  onClear={() => clearPatchValue("animationIterationCount")}
                />
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Surface
                </div>
                <EffectTextRow
                  label="Gradient"
                  value={activeEffectGradient}
                  changed={draftPatch.backgroundImage !== undefined}
                  onChange={(value) => setEffectPatchValue("backgroundImage", value)}
                  onClear={() => clearPatchValue("backgroundImage")}
                />
                {activeEffectGradientAngle !== null ? (
                  <EffectNumericRow
                    label="Angle"
                    value={`${activeEffectGradientAngle}deg`}
                    changed={draftPatch.backgroundImage !== undefined}
                    spec={EFFECT_ANGLE_SPEC}
                    onChange={(value) => {
                      const amount = Number.parseFloat(value);
                      if (Number.isFinite(amount)) {
                        setEffectPatchValue(
                          "backgroundImage",
                          cssGradientWithAngle(activeEffectGradient, amount),
                        );
                      }
                    }}
                  />
                ) : null}
                <EffectVectorRow
                  label="Scale"
                  value={effectValue(activeEffect, draftPatch, "backgroundSize")}
                  changed={draftPatch.backgroundSize !== undefined}
                  options={EFFECT_SCALE_OPTIONS}
                  onChange={(value) => setEffectPatchValue("backgroundSize", value)}
                  onClear={() => clearPatchValue("backgroundSize")}
                />
                <EffectVectorRow
                  label="Position"
                  value={effectValue(activeEffect, draftPatch, "backgroundPosition")}
                  changed={draftPatch.backgroundPosition !== undefined}
                  options={EFFECT_POSITION_OPTIONS}
                  onChange={(value) => setEffectPatchValue("backgroundPosition", value)}
                  onClear={() => clearPatchValue("backgroundPosition")}
                />
                <EffectNumericRow
                  label="Opacity"
                  value={effectValue(activeEffect, draftPatch, "opacity")}
                  changed={draftPatch.opacity !== undefined}
                  spec={EFFECT_NUMERIC_SPECS.opacity}
                  onChange={(value) => setEffectPatchValue("opacity", value)}
                  onClear={() => clearPatchValue("opacity")}
                />
                <EffectTextRow
                  label="Filter"
                  value={activeEffectFilter}
                  changed={draftPatch.filter !== undefined}
                  options={EFFECT_FILTER_OPTIONS}
                  onChange={(value) => setEffectPatchValue("filter", value)}
                  onClear={() => clearPatchValue("filter")}
                />
                {activeEffectFilterFunctions
                  ? activeEffectFilterFunctions.functions.map((filterFunction) => (
                      <EffectNumericRow
                        key={`filter-fn-${filterFunction.tokenIndex}-${filterFunction.name}`}
                        label={filterFunctionLabel(filterFunction.name)}
                        value={filterFunction.arg}
                        changed={draftPatch.filter !== undefined}
                        spec={filterFunctionSpec(filterFunction.name)}
                        onChange={(value) =>
                          setEffectPatchValue(
                            "filter",
                            cssFilterWithFunctionArg(
                              activeEffectFilterFunctions,
                              filterFunction,
                              value,
                            ),
                          )
                        }
                      />
                    ))
                  : null}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-black/10 bg-white/30 px-3 py-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:border-white/10 dark:bg-white/[0.035]">
              <div className="text-xs font-medium">No dynamic effects detected</div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Select an animated gradient, pseudo-element, filter, or visual background.
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between rounded-lg border border-black/10 bg-white/30 px-2 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:border-white/10 dark:bg-white/[0.035]">
        <div>
          <div className="text-xs font-medium">Apply to source</div>
          <div className="text-[10px] text-muted-foreground">Write changes to project files</div>
        </div>
        <Switch
          checked={manualOverride}
          className="h-4 w-7 border border-black/15 bg-slate-200/72 p-0.5 [--thumb-size:0.75rem] data-checked:border-black/20 data-checked:bg-gradient-to-r data-checked:from-slate-50/95 data-checked:to-slate-200/88 data-unchecked:bg-slate-200/72 dark:border-white/16 dark:data-checked:border-white/22 dark:data-checked:from-white/26 dark:data-checked:to-white/14 dark:data-unchecked:bg-white/10 [&_[data-slot=switch-thumb]]:!h-3 [&_[data-slot=switch-thumb]]:!translate-x-0 [&_[data-slot=switch-thumb]]:border [&_[data-slot=switch-thumb]]:border-white/85 [&_[data-slot=switch-thumb]]:bg-slate-400 data-checked:[&_[data-slot=switch-thumb]]:!translate-x-3 data-checked:[&_[data-slot=switch-thumb]]:bg-slate-50 dark:[&_[data-slot=switch-thumb]]:border-white/65 dark:[&_[data-slot=switch-thumb]]:bg-white/66 dark:data-checked:[&_[data-slot=switch-thumb]]:border-white/80 dark:data-checked:[&_[data-slot=switch-thumb]]:bg-slate-100"
          onCheckedChange={setManualOverride}
        />
      </div>

      {sourceEdit.status === "confirm" || sourceEdit.status === "applying" ? (
        <div className="mt-3 rounded-lg border border-black/10 bg-white/30 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] dark:border-white/10 dark:bg-white/[0.035]">
          <div className="mb-1.5 truncate font-mono text-[10px] text-muted-foreground">
            {sourceEdit.plan.relativePath}:{sourceEdit.plan.line}
          </div>
          <div className="space-y-1">
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-red-500/10 px-1.5 py-1 font-mono text-[10px] leading-snug text-red-800 dark:bg-red-400/[0.12] dark:text-red-200">
              {`- ${sourceEdit.plan.before}`}
            </pre>
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-emerald-500/10 px-1.5 py-1 font-mono text-[10px] leading-snug text-emerald-800 dark:bg-emerald-400/[0.12] dark:text-emerald-200">
              {`+ ${sourceEdit.plan.after}`}
            </pre>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={sourceEdit.status === "applying"}
              onClick={() => setSourceEdit({ status: "idle" })}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={sourceEdit.status === "applying"}
              onClick={() => confirmSourceEdit(sourceEdit.plan)}
            >
              {sourceEdit.status === "applying" ? "Applying..." : "Apply change"}
            </Button>
          </div>
        </div>
      ) : null}

      {sourceEdit.status === "error" ? (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-400/10 p-2 dark:border-amber-300/20 dark:bg-amber-300/[0.07]">
          <div className="text-[11px] text-amber-900 dark:text-amber-100">{sourceEdit.message}</div>
          <div className="mt-1 text-[10px] text-amber-800/80 dark:text-amber-200/70">
            The agent can route this change through the project's styling system instead.
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSourceEdit({ status: "idle" })}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setSourceEdit({ status: "idle" });
                onAttachContext(draftPatch, true);
              }}
            >
              Ask agent instead
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraftPatch({});
              onResetPreview();
            }}
          >
            Reset
          </Button>
          {changedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() => copyToClipboard(browserStylePatchToCssText(normalizedPatch))}
            >
              {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {isCopied ? "Copied" : "Copy CSS"}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {manualOverride ? (
            <Button
              type="button"
              size="sm"
              disabled={changedCount === 0 || sourceEdit.status !== "idle"}
              onClick={beginSourceEdit}
            >
              {sourceEdit.status === "planning" ? "Locating source..." : "Apply to source"}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => onAttachContext(draftPatch, false)}>
              Attach
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
