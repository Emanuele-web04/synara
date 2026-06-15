// FILE: BoxModelVisualizer.tsx
// Purpose: Compact box-model controls for the live editor element properties panel.
// Layer: Browser editor UI

import {
  memo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type {
  BrowserElementEditorContext,
  BrowserElementStylePatch,
} from "~/lib/browserEditorContext";
import { cn } from "~/lib/utils";

type BoxProperty = Extract<
  keyof BrowserElementStylePatch,
  "margin" | "padding" | "borderWidth"
>;
type BoxSide = "top" | "right" | "bottom" | "left";

const BOX_SIDES: readonly BoxSide[] = ["top", "right", "bottom", "left"];
const BOX_SIDE_LABELS: Record<BoxSide, string> = {
  top: "T",
  right: "R",
  bottom: "B",
  left: "L",
};
const BOX_MODEL_GEOMETRY = {
  borderInset: 19,
  paddingInset: 38,
  contentInset: 58,
  cueSize: 8,
} as const;

interface BoxSides {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

interface ParsedBoxValue {
  supported: boolean;
  sides: BoxSides;
  raw: string;
}

interface BoxLayerModel {
  property: BoxProperty;
  label: string;
  description: string;
  parsed: ParsedBoxValue;
}

interface BoxModelVisualizerProps {
  element: BrowserElementEditorContext;
  patch: BrowserElementStylePatch;
  onChange: (name: BoxProperty, value: string) => void;
}

function splitCssShorthand(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (const character of value.trim()) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      current += character;
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function expandBoxShorthand(value: string | undefined): ParsedBoxValue {
  const raw = value?.trim() || "0px";
  const tokens = splitCssShorthand(raw);
  if (tokens.length < 1 || tokens.length > 4 || raw.includes("/")) {
    return {
      supported: false,
      raw,
      sides: { top: raw, right: raw, bottom: raw, left: raw },
    };
  }

  const [top, right = top, bottom = top, left = right] = tokens;
  return {
    supported: true,
    raw,
    sides: { top, right, bottom, left },
  };
}

function collapseBoxSides(sides: BoxSides): string {
  if (sides.top === sides.right && sides.top === sides.bottom && sides.top === sides.left) {
    return sides.top;
  }
  if (sides.top === sides.bottom && sides.right === sides.left) {
    return `${sides.top} ${sides.right}`;
  }
  if (sides.right === sides.left) {
    return `${sides.top} ${sides.right} ${sides.bottom}`;
  }
  return `${sides.top} ${sides.right} ${sides.bottom} ${sides.left}`;
}

function parseLength(value: string): { amount: number; unit: string } | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z%]*)$/i);
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2] || "px" };
}

function formatLength(value: number, unit: string): string {
  return `${Number(value.toFixed(1)).toString()}${unit}`;
}

function compactBoxValue(value: string): string {
  return value.trim().replace(/^0(?:\.0+)?px$/i, "0");
}

function summarizeBoxValue(parsed: ParsedBoxValue): string {
  if (!parsed.supported) return parsed.raw;
  const { top, right, bottom, left } = parsed.sides;
  if (top === right && top === bottom && top === left) {
    return compactBoxValue(top);
  }
  if (top === bottom && right === left) {
    return `${compactBoxValue(top)} / ${compactBoxValue(right)}`;
  }
  return "mixed";
}

function sideValueAriaLabel(property: BoxProperty, side: BoxSide): string {
  return `${property.replace(/([A-Z])/g, " $1").toLowerCase()} ${side}`;
}

function useDelayedTooltip(delay = 500) {
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queueTooltip = () => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setShowTooltip(true), delay);
  };

  const hideTooltip = () => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = null;
    setShowTooltip(false);
  };

  useEffect(
    () => () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    },
    [],
  );

  return { hideTooltip, queueTooltip, showTooltip };
}

function BoxTooltip({
  anchorRef,
  children,
  placement,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: string;
  placement: "top" | "bottom";
}) {
  const anchor = anchorRef.current;
  if (!anchor || typeof document === "undefined") return null;

  const rect = anchor.getBoundingClientRect();
  const tooltipWidth = 160;
  const viewportPadding = 12;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, viewportPadding + tooltipWidth / 2),
    window.innerWidth - viewportPadding - tooltipWidth / 2,
  );
  const top = placement === "top" ? rect.top - 8 : rect.bottom + 8;

  return createPortal(
    <div
      className="pointer-events-none fixed z-[10000] w-40 -translate-x-1/2 rounded-md border border-black/8 bg-zinc-950/88 px-2 py-1 text-left text-[9px] leading-snug text-white shadow-xl backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/88"
      style={{
        left,
        top,
        transform: `translateX(-50%) translateY(${placement === "top" ? "-100%" : "0"})`,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function BoxSideControl({
  property,
  side,
  value,
  disabled,
  onCommit,
}: {
  property: BoxProperty;
  side: BoxSide;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const scrubRef = useRef<{
    pointerId: number;
    startX: number;
    startAmount: number;
    unit: string;
  } | null>(null);

  useEffect(() => {
    if (!scrubRef.current) setDraftValue(value);
  }, [value]);

  const commit = (nextValue: string) => {
    const trimmed = nextValue.trim();
    if (!trimmed || disabled) {
      setDraftValue(value);
      return;
    }
    onCommit(trimmed);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    const nextValue = formatLength(
      Math.max(0, scrub.startAmount + (event.clientX - scrub.startX) * 0.45),
      scrub.unit,
    );
    setDraftValue(nextValue);
    onCommit(nextValue);
  };

  return (
    <div
      className={cn(
        "flex h-4 min-w-0 items-center overflow-hidden rounded-[5px] border border-black/8 bg-white/42 text-[8px] shadow-[inset_0_1px_0_rgba(255,255,255,0.44)] backdrop-blur-2xl transition hover:bg-white/58 dark:border-white/10 dark:bg-white/[0.045] dark:hover:bg-white/[0.075]",
        disabled && "opacity-60",
      )}
    >
      <button
        type="button"
        className="flex h-full w-3.5 shrink-0 cursor-ew-resize items-center justify-center border-r border-black/8 text-[7px] font-semibold text-muted-foreground transition hover:text-foreground disabled:cursor-default dark:border-white/10"
        title={disabled ? "Edit the full shorthand below" : "Drag horizontally to adjust"}
        disabled={disabled || !parseLength(value)}
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled) return;
          const parsed = parseLength(draftValue || value);
          if (!parsed) return;
          event.preventDefault();
          scrubRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startAmount: parsed.amount,
            unit: parsed.unit,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={onHandlePointerMove}
        onPointerUp={(event) => {
          if (scrubRef.current?.pointerId !== event.pointerId) return;
          scrubRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (scrubRef.current?.pointerId !== event.pointerId) return;
          scrubRef.current = null;
        }}
      >
        {BOX_SIDE_LABELS[side]}
      </button>
      <input
        aria-label={sideValueAriaLabel(property, side)}
        value={draftValue}
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent px-0.5 text-center font-medium text-slate-950 outline-none placeholder:text-muted-foreground disabled:cursor-default dark:text-foreground"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setDraftValue(event.target.value);
          if (event.target.value.trim()) onCommit(event.target.value.trim());
        }}
        onBlur={() => commit(draftValue)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraftValue(value);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function BoxLayerRect({
  model,
  tone,
  inset,
  active,
  selected,
  previewed,
  dimmed,
  onHover,
  onSelect,
}: {
  model: BoxLayerModel;
  tone: "margin" | "border" | "padding";
  inset: number;
  active: boolean;
  selected: boolean;
  previewed: boolean;
  dimmed: boolean;
  onHover: (property: BoxProperty | null) => void;
  onSelect: () => void;
}) {
  const layerClassName = {
    margin:
      "border-black/8 bg-white/[0.16] dark:border-white/10 dark:bg-white/[0.028]",
    border:
      "border-black/8 bg-white/[0.18] dark:border-white/10 dark:bg-white/[0.032]",
    padding:
      "border-black/8 bg-white/[0.2] dark:border-white/10 dark:bg-white/[0.036]",
  }[tone];

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "absolute rounded-lg border shadow-[inset_0_1px_0_rgba(255,255,255,0.36)] outline-none backdrop-blur-2xl transition-[border-color,background-color,box-shadow,opacity] duration-150",
        layerClassName,
        active &&
          "border-cyan-400/28 shadow-[inset_0_1px_0_rgba(255,255,255,0.42),0_0_0_1px_rgba(34,211,238,0.08)] dark:border-cyan-200/18",
        selected &&
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.44),0_0_0_1px_rgba(34,211,238,0.22)]",
        previewed &&
          "border-cyan-300/22 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_0_0_1px_rgba(34,211,238,0.06)] dark:border-cyan-200/14",
        dimmed && "opacity-55",
      )}
      style={{ inset }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onFocus={() => {
        onHover(model.property);
      }}
      onBlur={() => onHover(null)}
      onPointerEnter={() => {
        onHover(model.property);
      }}
      onPointerLeave={() => {
        onHover(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="pointer-events-none absolute left-3 top-1.5 flex max-w-[calc(100%-4rem)] items-center gap-1">
        <span className="text-[8px] font-semibold uppercase tracking-wide text-muted-foreground">
          {model.label}
        </span>
        <span className="min-w-0 truncate text-[8px] text-muted-foreground/70">
          {summarizeBoxValue(model.parsed)}
        </span>
      </div>
    </div>
  );
}

function BoxLayerHelpLabel({ model }: { model: BoxLayerModel }) {
  const { hideTooltip, queueTooltip, showTooltip } = useDelayedTooltip();
  const labelRef = useRef<HTMLSpanElement | null>(null);

  return (
    <div className="relative w-12 shrink-0">
      <span
        ref={labelRef}
        tabIndex={0}
        className="block truncate text-[8px] font-semibold uppercase tracking-wide text-muted-foreground outline-none transition hover:text-foreground focus-visible:text-foreground"
        onFocus={queueTooltip}
        onBlur={hideTooltip}
        onPointerEnter={queueTooltip}
        onPointerLeave={hideTooltip}
      >
        {model.label}
      </span>
      {showTooltip ? (
        <BoxTooltip anchorRef={labelRef} placement="bottom">
          {model.description}
        </BoxTooltip>
      ) : null}
    </div>
  );
}

function BoxMeasurementCue({
  visible,
  left,
  top,
  height,
}: {
  visible: boolean;
  left: number | string;
  top: number;
  height: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-20 overflow-visible text-cyan-700/70 opacity-0 transition-opacity duration-150 dark:text-cyan-100/68",
        visible && "opacity-100",
      )}
      style={{ left, top, height, width: BOX_MODEL_GEOMETRY.cueSize }}
      viewBox="0 0 8 24"
    >
      <path
        d="M4 3.5V20.5M4 3.5L2.3 6.2M4 3.5L5.7 6.2M4 20.5L2.3 17.8M4 20.5L5.7 17.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function BoxAreaCue({
  visible,
  selected,
  tone,
  outerInset,
  innerInset,
}: {
  visible: boolean;
  selected: boolean;
  tone: "margin" | "border" | "padding";
  outerInset: number;
  innerInset: number;
}) {
  const bandSize = innerInset - outerInset;
  const selectedFillClassName =
    tone === "margin"
      ? "bg-cyan-200/[0.26] dark:bg-cyan-100/[0.16]"
      : tone === "border"
        ? "bg-cyan-200/[0.22] dark:bg-cyan-100/[0.145]"
        : "bg-cyan-200/[0.18] dark:bg-cyan-100/[0.105]";
  const selectedRingClassName =
    tone === "margin"
      ? "ring-cyan-300/54 dark:ring-cyan-100/36"
      : tone === "border"
        ? "ring-cyan-300/70 dark:ring-cyan-100/54"
        : "ring-cyan-300/38 dark:ring-cyan-100/26";
  const idleRingClassName =
    tone === "border"
      ? "ring-cyan-400/38 dark:ring-cyan-200/28"
      : "ring-cyan-400/24 dark:ring-cyan-200/16";
  const bandMaskStyle = {
    inset: outerInset,
    padding: bandSize,
    WebkitMask:
      "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    maskComposite: "exclude",
  } as const;
  const borderEdgeMaskStyle = {
    padding: 1.6,
    WebkitMask:
      "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    maskComposite: "exclude",
  } as const;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-150",
        visible && "opacity-100",
      )}
    >
      <div
        className={cn(
          "absolute rounded-lg transition-colors duration-150",
          selected
            ? selectedFillClassName
            : "bg-cyan-200/[0.105] dark:bg-cyan-100/[0.055]",
        )}
        style={bandMaskStyle}
      />
      {tone === "margin" || tone === "padding" ? (
        <div
          className={cn(
            "absolute rounded-lg opacity-45 transition-opacity duration-150",
            selected && "opacity-70",
          )}
          style={{
            ...bandMaskStyle,
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(103, 232, 249, 0.34) 0 1px, transparent 1px 6px)",
          }}
        />
      ) : null}
      {tone === "border"
        ? [outerInset, innerInset].map((inset) => (
            <div
              key={inset}
              className={cn(
                "synara-box-border-edge-shimmer absolute rounded-lg opacity-55 transition-opacity duration-150",
                selected && "opacity-90",
              )}
              style={{ ...borderEdgeMaskStyle, inset }}
            />
          ))
        : null}
      <div
        className={cn(
          "absolute rounded-lg ring-1 transition-[box-shadow,--tw-ring-color] duration-150",
          selected ? selectedRingClassName : idleRingClassName,
          tone === "border" &&
            "ring-[1.5px] shadow-[0_0_0_1px_rgba(34,211,238,0.1),0_0_12px_rgba(103,232,249,0.1)]",
          tone === "border" &&
            selected &&
            "shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_0_14px_rgba(103,232,249,0.16)]",
        )}
        style={{ inset: outerInset }}
      />
      <div
        className={cn(
          "absolute rounded-lg ring-1 transition-[box-shadow,--tw-ring-color] duration-150",
          selected ? selectedRingClassName : idleRingClassName,
          tone === "border" &&
            "ring-[1.5px] shadow-[0_0_0_1px_rgba(34,211,238,0.1),0_0_12px_rgba(103,232,249,0.1)]",
          tone === "border" &&
            selected &&
            "shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_0_14px_rgba(103,232,249,0.16)]",
        )}
        style={{ inset: innerInset }}
      />
    </div>
  );
}

function BoxLayerSummaryItem({
  active,
  model,
  onActivate,
}: {
  active: boolean;
  model: BoxLayerModel;
  onActivate: () => void;
}) {
  const { hideTooltip, queueTooltip, showTooltip } = useDelayedTooltip();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        "relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-[5px] px-1 py-1 text-[8px] transition",
        active
          ? "bg-cyan-300/18 text-slate-950 dark:bg-cyan-200/[0.08] dark:text-foreground"
          : "text-muted-foreground hover:bg-white/36 hover:text-foreground dark:hover:bg-white/[0.055]",
      )}
      onClick={onActivate}
      onFocus={queueTooltip}
      onBlur={hideTooltip}
      onPointerEnter={queueTooltip}
      onPointerLeave={hideTooltip}
    >
      <span className="truncate font-semibold uppercase tracking-wide">{model.label}</span>
      <span className="truncate">{summarizeBoxValue(model.parsed)}</span>
      {showTooltip ? (
        <BoxTooltip anchorRef={buttonRef} placement="top">
          {model.description}
        </BoxTooltip>
      ) : null}
    </button>
  );
}

function BoxInnerDimCue({ visible, inset }: { visible: boolean; inset: number }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-[9] rounded-lg bg-transparent opacity-0 transition-opacity duration-150 dark:bg-black/24",
        visible && "opacity-100",
      )}
      style={{ inset }}
    />
  );
}

function ActiveLayerControls({
  model,
  onSideChange,
}: {
  model: BoxLayerModel;
  onSideChange: (property: BoxProperty, side: BoxSide, value: string) => void;
}) {
  return (
    <div className="flex min-h-7 items-center gap-1 rounded-md border border-black/8 bg-white/[0.22] px-1.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.38)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.03]">
      <BoxLayerHelpLabel model={model} />
      <div className="grid min-w-0 flex-1 grid-cols-4 gap-1">
        {BOX_SIDES.map((side) => (
          <BoxSideControl
            key={side}
            property={model.property}
            side={side}
            value={model.parsed.sides[side]}
            disabled={!model.parsed.supported}
            onCommit={(value) => onSideChange(model.property, side, value)}
          />
        ))}
      </div>
    </div>
  );
}

function BoxLayerSummary({
  models,
  activeProperty,
  onActivate,
}: {
  models: readonly BoxLayerModel[];
  activeProperty: BoxProperty | null;
  onActivate: (property: BoxProperty) => void;
}) {
  return (
    <div className="flex min-h-7 items-center gap-1 rounded-md border border-black/8 bg-white/[0.18] px-1 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.34)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.024]">
      {models.map((model) => (
        <BoxLayerSummaryItem
          key={model.property}
          active={activeProperty === model.property}
          model={model}
          onActivate={() => onActivate(model.property)}
        />
      ))}
    </div>
  );
}

export const BoxModelVisualizer = memo(function BoxModelVisualizer({
  element,
  patch,
  onChange,
}: BoxModelVisualizerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const style = element.style;
  const margin = expandBoxShorthand(patch.margin ?? style?.margin);
  const border = expandBoxShorthand(patch.borderWidth ?? style?.borderWidth);
  const padding = expandBoxShorthand(patch.padding ?? style?.padding);
  const [hoveredProperty, setHoveredProperty] = useState<BoxProperty | null>(null);
  const [selectedProperty, setSelectedProperty] = useState<BoxProperty | null>(null);
  const models: BoxLayerModel[] = [
    {
      property: "margin",
      label: "Margin",
      description: "Outer space that pushes neighboring elements away.",
      parsed: margin,
    },
    {
      property: "borderWidth",
      label: "Border",
      description: "The edge between margin and padding.",
      parsed: border,
    },
    {
      property: "padding",
      label: "Padding",
      description: "Inner space between content and border.",
      parsed: padding,
    },
  ];
  const activeProperty = selectedProperty ?? hoveredProperty;
  const activeModel = activeProperty
    ? (models.find((model) => model.property === activeProperty) ?? null)
    : null;
  const isLayerActive = (property: BoxProperty) =>
    activeProperty === property || hoveredProperty === property;
  const isLayerDimmed = (property: BoxProperty) =>
    activeProperty !== null && activeProperty !== property && hoveredProperty !== property;

  useEffect(() => {
    if (!selectedProperty) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      setSelectedProperty(null);
      setHoveredProperty(null);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [selectedProperty]);

  const updateSide = (property: BoxProperty, side: BoxSide, value: string) => {
    const parsed = expandBoxShorthand(patch[property] ?? style?.[property]);
    if (!parsed.supported) return;
    onChange(property, collapseBoxSides({ ...parsed.sides, [side]: value }));
  };

  return (
    <div
      ref={rootRef}
      className="rounded-lg border border-black/8 bg-white/[0.16] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.38)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.022]"
    >
      <style>{`
        @property --synara-box-border-angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        @keyframes synara-box-border-shimmer {
          to {
            --synara-box-border-angle: 360deg;
          }
        }

        .synara-box-border-edge-shimmer {
          --synara-box-border-glint: rgba(34, 211, 238, 0.6);
          --synara-box-border-glint-core: rgba(255, 255, 255, 0.72);
          animation: synara-box-border-shimmer 2.8s linear infinite;
          background-image: conic-gradient(
            from var(--synara-box-border-angle),
            transparent 0deg,
            transparent 22deg,
            var(--synara-box-border-glint) 38deg,
            var(--synara-box-border-glint-core) 46deg,
            var(--synara-box-border-glint) 54deg,
            transparent 76deg,
            transparent 360deg
          );
        }

        .dark .synara-box-border-edge-shimmer {
          --synara-box-border-glint: rgba(236, 254, 255, 0.66);
          --synara-box-border-glint-core: rgba(255, 255, 255, 0.92);
        }
      `}</style>
      <div
        className="relative h-36"
        onClick={() => {
          setSelectedProperty(null);
          setHoveredProperty(null);
        }}
      >
        <BoxLayerRect
          model={models[0]}
          tone="margin"
          inset={0}
          active={activeProperty === "margin"}
          selected={selectedProperty === "margin"}
          previewed={hoveredProperty === "margin" && selectedProperty !== "margin"}
          dimmed={isLayerDimmed("margin")}
          onHover={setHoveredProperty}
          onSelect={() => setSelectedProperty("margin")}
        />
        <BoxLayerRect
          model={models[1]}
          tone="border"
          inset={BOX_MODEL_GEOMETRY.borderInset}
          active={activeProperty === "borderWidth"}
          selected={selectedProperty === "borderWidth"}
          previewed={hoveredProperty === "borderWidth" && selectedProperty !== "borderWidth"}
          dimmed={isLayerDimmed("borderWidth")}
          onHover={setHoveredProperty}
          onSelect={() => setSelectedProperty("borderWidth")}
        />
        <BoxLayerRect
          model={models[2]}
          tone="padding"
          inset={BOX_MODEL_GEOMETRY.paddingInset}
          active={activeProperty === "padding"}
          selected={selectedProperty === "padding"}
          previewed={hoveredProperty === "padding" && selectedProperty !== "padding"}
          dimmed={isLayerDimmed("padding")}
          onHover={setHoveredProperty}
          onSelect={() => setSelectedProperty("padding")}
        />
        <div
          className={cn(
            "pointer-events-none absolute flex flex-col items-center justify-center rounded-md border border-black/8 bg-white/[0.48] px-2 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] backdrop-blur-xl transition-opacity dark:border-white/10 dark:bg-white/[0.13]",
            activeProperty && "opacity-85",
          )}
          style={{ inset: BOX_MODEL_GEOMETRY.contentInset }}
        >
          <div className="text-[8px] font-semibold uppercase tracking-wide text-muted-foreground">
            Content
          </div>
        </div>
        <BoxAreaCue
          visible={isLayerActive("margin")}
          selected={selectedProperty === "margin"}
          tone="margin"
          outerInset={0}
          innerInset={BOX_MODEL_GEOMETRY.borderInset}
        />
        <BoxAreaCue
          visible={isLayerActive("borderWidth")}
          selected={selectedProperty === "borderWidth"}
          tone="border"
          outerInset={BOX_MODEL_GEOMETRY.borderInset}
          innerInset={BOX_MODEL_GEOMETRY.paddingInset}
        />
        <BoxInnerDimCue
          visible={isLayerActive("borderWidth")}
          inset={BOX_MODEL_GEOMETRY.paddingInset}
        />
        <BoxAreaCue
          visible={isLayerActive("padding")}
          selected={selectedProperty === "padding"}
          tone="padding"
          outerInset={BOX_MODEL_GEOMETRY.paddingInset}
          innerInset={BOX_MODEL_GEOMETRY.contentInset}
        />
        <BoxMeasurementCue
          visible={isLayerActive("margin")}
          left={`calc(50% - ${BOX_MODEL_GEOMETRY.cueSize / 2}px)`}
          top={1}
          height={BOX_MODEL_GEOMETRY.borderInset - 2}
        />
        <BoxMeasurementCue
          visible={isLayerActive("padding")}
          left={`calc(50% - ${BOX_MODEL_GEOMETRY.cueSize / 2}px)`}
          top={BOX_MODEL_GEOMETRY.paddingInset + 1}
          height={BOX_MODEL_GEOMETRY.contentInset - BOX_MODEL_GEOMETRY.paddingInset - 2}
        />
      </div>
      <div className="mt-1.5">
        {activeModel ? (
          <ActiveLayerControls model={activeModel} onSideChange={updateSide} />
        ) : (
          <BoxLayerSummary
            models={models}
            activeProperty={activeProperty}
            onActivate={setSelectedProperty}
          />
        )}
      </div>
    </div>
  );
});
