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
  type BrowserElementEditorContext,
  type BrowserElementStylePatch,
  normalizeBrowserElementStylePatch,
} from "~/lib/browserEditorContext";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "~/lib/icons";
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
  initialPatch?: BrowserElementStylePatch;
  onPreviewPatch: (patch: BrowserElementStylePatch) => void;
  onAttachContext: (patch: BrowserElementStylePatch, manualOverride: boolean) => void;
  onApplySourceEdit: (patch: BrowserElementStylePatch) => void;
  onResetPreview: () => void;
  onClose: () => void;
  onDragHandlePointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

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
}

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

const EMPTY_BROWSER_EFFECTS: NonNullable<BrowserElementEditorContext["effects"]> = [];

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
  fontSize: { defaultValue: 16, defaultUnit: "px", sensitivity: 0.35, step: 1, precision: 0 },
  fontWeight: {
    defaultValue: 400,
    defaultUnit: "",
    sensitivity: 2,
    step: 100,
    precision: 0,
    scrubStepPixels: 12,
    min: 0,
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
  },
  padding: { defaultValue: 0, defaultUnit: "px", sensitivity: 0.45, step: 1, precision: 0 },
  margin: { defaultValue: 0, defaultUnit: "px", sensitivity: 0.45, step: 1, precision: 0 },
  borderWidth: { defaultValue: 0, defaultUnit: "px", sensitivity: 0.2, step: 0.5, precision: 1 },
  borderRadius: { defaultValue: 0, defaultUnit: "px", sensitivity: 0.45, step: 1, precision: 0 },
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

function rgbToHex(value: string | undefined): string {
  if (!value) return "#000000";
  if (/^#[\da-f]{6}$/i.test(value.trim())) return value.trim();
  const match = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return "#000000";
  return [match[1], match[2], match[3]]
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")
    .replace(/^/, "#");
}

function patchValue(
  element: BrowserElementEditorContext,
  patch: BrowserElementStylePatch,
  key: StylePatchKey,
): string {
  return patch[key] ?? element.style?.[key] ?? "";
}

function unquoteFontFamilyName(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function fontOptionDisplayName(value: string, label?: string): string {
  const cleanLabel = label?.replace(/^Current:\s*/i, "").replace(/\s+stack$/i, "").trim();
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
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));
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
      setHighlightedIndex((current) =>
        (current + direction + filteredOptions.length) % filteredOptions.length,
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

function FieldShell({
  label,
  children,
  scrub,
}: {
  label: string;
  children: ReactNode;
  scrub?: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  };
}) {
  const labelClassName = cn(
    "truncate text-left text-[10px] font-medium uppercase text-muted-foreground",
    scrub && "cursor-ew-resize select-none hover:text-foreground",
  );
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2">
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
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: StylePatchKey;
  label: string;
  options: readonly OptionItem[];
  onChange: (name: StylePatchKey, value: string) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name] !== undefined;
  const isFontFamily = name === "fontFamily";
  return (
    <FieldShell label={label}>
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

function NumericRow({
  element,
  patch,
  name,
  label,
  spec,
  onChange,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: StylePatchKey;
  label: string;
  spec: NumericSpec;
  onChange: (name: StylePatchKey, value: string) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name]?.trim().length ? true : false;
  const [draftValue, setDraftValue] = useState(value);
  const scrubRef = useRef<{ pointerId: number; startX: number; startAmount: number; unit: string } | null>(
    null,
  );
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
    onChange(name, nextValue);
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

  return (
    <FieldShell label={label} scrub={scrubHandlers}>
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

function ColorField({
  element,
  patch,
  name,
  label,
  onChange,
}: {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  name: Extract<StylePatchKey, "color" | "backgroundColor" | "borderColor">;
  label: string;
  onChange: (name: StylePatchKey, value: string) => void;
}) {
  const value = patchValue(element, patch, name);
  const changed = patch[name]?.trim().length ? true : false;
  return (
    <label className="space-y-1">
      <span className="block text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </span>
      <div className={cn("flex h-8 items-center gap-2 px-2", controlClassName(changed))}>
        <input
          type="color"
          value={rgbToHex(value)}
          className="size-5 rounded border-0 bg-transparent p-0"
          onChange={(event) => onChange(name, event.target.value)}
        />
        <Input
          size="sm"
          value={value}
          nativeInput
          className="min-h-0 flex-1 border-0 bg-transparent px-0 text-[11px]"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(name, event.target.value)}
        />
      </div>
    </label>
  );
}

function EffectTextRow({
  label,
  value,
  changed,
  onChange,
}: {
  label: string;
  value: string;
  changed: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label}>
      <Input
        size="sm"
        value={value}
        nativeInput
        className={cn("min-h-0 border-0 bg-transparent", controlClassName(changed))}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

function EffectSelectRow({
  label,
  value,
  changed,
  options,
  onChange,
}: {
  label: string;
  value: string;
  changed: boolean;
  options: readonly OptionItem[];
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label}>
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
}: {
  label: string;
  value: string;
  changed: boolean;
  spec: NumericSpec;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const scrubRef = useRef<{ pointerId: number; startX: number; startAmount: number; unit: string } | null>(
    null,
  );
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
    const rawValue = scrub.startAmount + deltaX * spec.sensitivity;
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

  return (
    <FieldShell label={label} scrub={scrubHandlers}>
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

export const ElementPropertiesPanel = memo(function ElementPropertiesPanel({
  element,
  initialPatch,
  onPreviewPatch,
  onAttachContext,
  onApplySourceEdit,
  onResetPreview,
  onClose,
  onDragHandlePointerDown,
}: ElementPropertiesPanelProps) {
  const [draftPatch, setDraftPatch] = useState<BrowserElementStylePatch>(initialPatch ?? {});
  const [manualOverride, setManualOverride] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTab>("style");
  const [activeEffectIndex, setActiveEffectIndex] = useState(0);
  const previewFrameRef = useRef<number | null>(null);
  const lastPreviewKeyRef = useRef("");
  const elementKey = useMemo(
    () => `${element.url}\u0000${element.selector}\u0000${element.tagName}`,
    [element.selector, element.tagName, element.url],
  );
  const normalizedPatch = useMemo(
    () => normalizeBrowserElementStylePatch(draftPatch),
    [draftPatch],
  );
  const changedCount = Object.keys(normalizedPatch).length;
  const effects = element.effects ?? EMPTY_BROWSER_EFFECTS;
  const activeEffect = effects[Math.min(activeEffectIndex, Math.max(0, effects.length - 1))] ?? null;
  const activeEffectGradient = useMemo(
    () => (activeEffect ? effectValue(activeEffect, draftPatch, "backgroundImage") : ""),
    [activeEffect, draftPatch],
  );
  const activeEffectColors = useMemo(
    () => extractCssColors(activeEffectGradient).slice(0, 4),
    [activeEffectGradient],
  );
  const fontFamilyOptions = useMemo(
    () =>
      element.availableFonts && element.availableFonts.length > 0
        ? element.availableFonts
        : BROWSER_SYSTEM_FONT_OPTIONS,
    [element.availableFonts],
  );

  const setPatchValue = useCallback((name: StylePatchKey, value: string) => {
    setDraftPatch((current) => ({
      ...current,
      [name]: value,
    }));
  }, []);

  const setEffectPatchValue = useCallback((name: EffectPatchKey, value: string) => {
    if (!activeEffect) return;
    setDraftPatch((current) => ({
      ...current,
      effectTarget: activeEffect.source,
      [name]: value,
    }));
  }, [activeEffect]);

  useEffect(() => {
    setDraftPatch(initialPatch ?? {});
    setManualOverride(false);
    setActiveEffectIndex(0);
    lastPreviewKeyRef.current = "";
  }, [elementKey, initialPatch]);

  useEffect(() => {
    if (activeEffectIndex >= effects.length) {
      setActiveEffectIndex(Math.max(0, effects.length - 1));
    }
  }, [activeEffectIndex, effects.length]);

  useEffect(() => {
    const previewKey = JSON.stringify(normalizedPatch);
    if (lastPreviewKeyRef.current === previewKey) {
      return;
    }
    lastPreviewKeyRef.current = previewKey;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      onPreviewPatch(normalizedPatch);
    });
    return () => {
      if (previewFrameRef.current !== null) {
        window.cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    };
  }, [normalizedPatch, onPreviewPatch]);

  return (
    <div className="max-h-[min(42rem,calc(100vh-2rem))] w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-black/10 bg-white/50 p-2.5 text-slate-950 shadow-[0_22px_70px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.78)] backdrop-blur-2xl dark:border-white/10 dark:bg-[#111315]/74 dark:text-foreground dark:shadow-[0_18px_60px_rgba(0,0,0,0.46),inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div
        className={cn("mb-3 flex items-start gap-3", onDragHandlePointerDown && "cursor-move")}
        onPointerDown={onDragHandlePointerDown}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Element properties</div>
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

      <div className="mb-2.5 grid grid-cols-2 rounded-md border border-black/10 bg-white/30 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.52)] dark:border-white/10 dark:bg-white/[0.03]">
        {(["style", "effects"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={cn(
              "h-6 rounded-[5px] text-[10px] font-medium capitalize text-muted-foreground transition",
              activeTab === tab && "bg-white/66 text-slate-950 shadow-sm dark:bg-white/[0.08] dark:text-foreground",
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
            />
            <ColorField
              element={element}
              patch={draftPatch}
              name="backgroundColor"
              label="Background"
              onChange={setPatchValue}
            />
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">Typography</div>
            <SelectRow
              element={element}
              patch={draftPatch}
              name="fontFamily"
              label="Family"
              options={fontFamilyOptions}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="fontSize"
              label="Size"
              spec={NUMERIC_SPECS.fontSize}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="fontWeight"
              label="Weight"
              spec={NUMERIC_SPECS.fontWeight}
              onChange={setPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="fontStyle"
              label="Style"
              options={FONT_STYLE_OPTIONS}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="lineHeight"
              label="Line"
              spec={NUMERIC_SPECS.lineHeight}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="letterSpacing"
              label="Tracking"
              spec={NUMERIC_SPECS.letterSpacing}
              onChange={setPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="textAlign"
              label="Align"
              options={TEXT_ALIGN_OPTIONS}
              onChange={setPatchValue}
            />
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">Box</div>
            <BoxModelVisualizer
              element={element}
              patch={draftPatch}
              onChange={setPatchValue}
            />
            <ColorField
              element={element}
              patch={draftPatch}
              name="borderColor"
              label="Border"
              onChange={setPatchValue}
            />
            <div className="pt-1.5">
              <NumericRow
                element={element}
                patch={draftPatch}
                name="padding"
                label="Padding"
                spec={NUMERIC_SPECS.padding}
                onChange={setPatchValue}
              />
            </div>
            <NumericRow
              element={element}
              patch={draftPatch}
              name="margin"
              label="Margin"
              spec={NUMERIC_SPECS.margin}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="borderWidth"
              label="Border"
              spec={NUMERIC_SPECS.borderWidth}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="borderRadius"
              label="Radius"
              spec={NUMERIC_SPECS.borderRadius}
              onChange={setPatchValue}
            />
            <SelectRow
              element={element}
              patch={draftPatch}
              name="boxShadow"
              label="Shadow"
              options={SHADOW_OPTIONS}
              onChange={setPatchValue}
            />
            <NumericRow
              element={element}
              patch={draftPatch}
              name="opacity"
              label="Opacity"
              spec={NUMERIC_SPECS.opacity}
              onChange={setPatchValue}
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
                    {activeEffectColors.map((color, index) => {
                      const updateColorStop = (nextColor: string) => {
                        setEffectPatchValue(
                          "backgroundImage",
                          replaceCssColorAtIndex(activeEffectGradient, index, nextColor),
                        );
                      };
                      return (
                        <label
                          key={`${activeEffect.source}-color-${index}`}
                          className="group relative flex size-7 items-center justify-center rounded-md border border-black/10 bg-white/42 shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] ring-1 ring-black/10 transition hover:border-slate-500/30 dark:border-white/10 dark:bg-black/20 dark:ring-black/20 dark:hover:border-white/25"
                          title={`Color stop ${index + 1}`}
                        >
                          <span
                            className="size-4 rounded-[4px] border border-white/25 shadow-inner"
                            style={{ background: color }}
                          />
                          <input
                            type="color"
                            value={rgbToHex(color)}
                            className="absolute inset-0 cursor-pointer opacity-0"
                            onInput={(event) => updateColorStop(event.currentTarget.value)}
                          />
                        </label>
                      );
                    })}
                    <div className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
                      {activeEffectColors.length} stops
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">Motion</div>
                <EffectNumericRow
                  label="Speed"
                  value={effectValue(activeEffect, draftPatch, "animationDuration")}
                  changed={draftPatch.animationDuration !== undefined}
                  spec={EFFECT_NUMERIC_SPECS.speed}
                  onChange={(value) => setEffectPatchValue("animationDuration", value)}
                />
                <EffectSelectRow
                  label="Timing"
                  value={effectValue(activeEffect, draftPatch, "animationTimingFunction")}
                  changed={draftPatch.animationTimingFunction !== undefined}
                  options={EFFECT_TIMING_OPTIONS}
                  onChange={(value) => setEffectPatchValue("animationTimingFunction", value)}
                />
                <EffectSelectRow
                  label="Repeat"
                  value={effectValue(activeEffect, draftPatch, "animationIterationCount")}
                  changed={draftPatch.animationIterationCount !== undefined}
                  options={EFFECT_ITERATION_OPTIONS}
                  onChange={(value) => setEffectPatchValue("animationIterationCount", value)}
                />
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">Surface</div>
                <EffectTextRow
                  label="Gradient"
                  value={activeEffectGradient}
                  changed={draftPatch.backgroundImage !== undefined}
                  onChange={(value) => setEffectPatchValue("backgroundImage", value)}
                />
                <EffectTextRow
                  label="Scale"
                  value={effectValue(activeEffect, draftPatch, "backgroundSize")}
                  changed={draftPatch.backgroundSize !== undefined}
                  onChange={(value) => setEffectPatchValue("backgroundSize", value)}
                />
                <EffectTextRow
                  label="Position"
                  value={effectValue(activeEffect, draftPatch, "backgroundPosition")}
                  changed={draftPatch.backgroundPosition !== undefined}
                  onChange={(value) => setEffectPatchValue("backgroundPosition", value)}
                />
                <EffectNumericRow
                  label="Opacity"
                  value={effectValue(activeEffect, draftPatch, "opacity")}
                  changed={draftPatch.opacity !== undefined}
                  spec={EFFECT_NUMERIC_SPECS.opacity}
                  onChange={(value) => setEffectPatchValue("opacity", value)}
                />
                <EffectTextRow
                  label="Filter"
                  value={effectValue(activeEffect, draftPatch, "filter")}
                  changed={draftPatch.filter !== undefined}
                  onChange={(value) => setEffectPatchValue("filter", value)}
                />
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

      <div className="mt-3 flex items-center justify-between gap-2">
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
        <div className="flex items-center gap-2">
          {manualOverride ? (
            <Button
              type="button"
              size="sm"
              disabled={changedCount === 0}
              onClick={() => onApplySourceEdit(draftPatch)}
            >
              Apply to source
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
