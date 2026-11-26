// FILE: InspectorControls.tsx
// Purpose: Dense building blocks of the canvas inspector: sections, field rows, scrubbable
//          number fields, icon toggle groups, selects, checkbox rows and the property row
//          shared by Fill, Text color, Border and Shadow. Every control is the app's own at
//          its densest size: xs inputs and selects on the borderless soft fill, icon-xs
//          buttons, the "sm" SegmentedPicker squared off to the fields' radius, the app
//          checkbox; sections are 32px headers (the sidebar's muted label) over 24px rows 8px
//          apart.
// Layer: Canvas editor UI
// Depends on: @base-ui NumberField (scrubbing), ui/input, ui/toggle, ui/select, ui/checkbox,
//             SegmentedPicker, ComposerPickerSelectPopup.

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import { AddPlusIcon, DragHandleIcon, MinusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME } from "~/sidebarRowStyles";
import { ComposerPickerSelectPopup } from "../../chat/ComposerPickerMenuPopup";
import { SegmentedPicker } from "../../SegmentedPicker";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import { IconButton } from "../../ui/icon-button";
import { inputControlClassName } from "../../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { TREE_SECTION_LABEL_CLASS_NAME } from "../../ui/TreeRow";
import { clamp, formatNumber, largeStepFor, parseCssInput, type CssInput } from "./inspectorValues";

// ── Shared chrome ────────────────────────────────────────────────────────

/**
 * Field chrome shared by every inspector input: the app's xs input control, borderless on the
 * soft fill. An open picker or popover for the field keeps its focus border.
 */
export const INSPECTOR_FIELD_CLASS_NAME = cn(
  inputControlClassName("xs", { filled: true }),
  "min-w-0 gap-1 px-1.5",
  "data-active:border-foreground/30 data-popup-open:border-foreground/30",
  "data-disabled:pointer-events-none data-disabled:opacity-64",
);

/** Bare text input inside an inspector field; it takes the field's text size. */
export const INSPECTOR_INPUT_CLASS_NAME =
  "font-system-ui h-full w-full min-w-0 bg-transparent tabular-nums outline-none placeholder:text-muted-foreground/72 disabled:cursor-default";

const NUDGE_COMMIT_DELAY_MS = 350;

// ── Section and rows ─────────────────────────────────────────────────────

export function InspectorSection({
  title,
  empty = false,
  disabled = false,
  collapsible = false,
  onAdd,
  headerAction,
  headerMenu,
  children,
}: {
  title: string;
  /** Header controls shown while the section has content (direction, more, add another…). */
  headerAction?: ReactNode;
  /** A header control shown even while the section is empty (e.g. Export's copy menu). */
  headerMenu?: ReactNode;
  /** Nothing set yet: the header is dimmed and clicking it adds a default value. */
  empty?: boolean;
  disabled?: boolean;
  /** The header toggles the body open and closed. */
  collapsible?: boolean;
  onAdd?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const canAdd = empty && onAdd && !disabled;
  // Content follows the 32px header directly; 24px rows 8px apart, 12px below.
  const body =
    !empty && children ? (
      <div className="flex flex-col gap-2 px-3 pt-1 pb-3">{children}</div>
    ) : null;
  // The title is the sidebar's muted section label; an unset section's comes up on hover, where
  // clicking it adds a value.
  const titleClassName = cn(
    TREE_SECTION_LABEL_CLASS_NAME,
    "transition-colors",
    canAdd && "group-hover/section:text-foreground",
  );
  return (
    <section
      data-canvas-section=""
      data-dimmed={empty ? "" : undefined}
      className="group/section border-b border-border text-foreground"
    >
      <header className="flex h-8 items-center gap-2 px-3">
        {collapsible && !empty ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex h-full min-w-0 flex-1 items-center gap-1 text-start outline-none focus-visible:underline"
            onClick={() => setOpen((value) => !value)}
          >
            <span className={cn("truncate pb-px", titleClassName)}>{title}</span>
            <DisclosureChevron
              open={open}
              className={cn("size-3", SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME)}
            />
          </button>
        ) : canAdd ? (
          <button
            type="button"
            className={cn(
              "h-full min-w-0 flex-1 truncate pb-px text-start outline-none focus-visible:underline",
              titleClassName,
            )}
            onClick={onAdd}
          >
            {title}
          </button>
        ) : (
          <h3 className={cn("min-w-0 flex-1 truncate pb-px", titleClassName)}>{title}</h3>
        )}
        {headerMenu}
        {canAdd ? (
          <IconButton
            label={t("workspace:canvasInspectorAdd", { name: title })}
            tooltip={t("workspace:canvasInspectorAdd", { name: title })}
            className="-me-1"
            onClick={onAdd}
          >
            <AddPlusIcon />
          </IconButton>
        ) : null}
        {!empty && !disabled ? headerAction : null}
      </header>
      {collapsible && body ? <DisclosureRegion open={open}>{body}</DisclosureRegion> : body}
    </section>
  );
}

/**
 * A sub-block revealed by a toggle (individual corners, per-side padding). It stays mounted
 * while closed, so its spacing is inside: place it in a gapless column under its row.
 */
export function InspectorExpand({
  open,
  dense = false,
  children,
}: {
  open: boolean;
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <DisclosureRegion
      open={open}
      contentClassName={cn("flex flex-col", dense ? "gap-1.5 pt-1.5" : "gap-2 pt-2")}
    >
      {children}
    </DisclosureRegion>
  );
}

/**
 * One inspector row of up to two fields, full width. A label column is only used
 * inside popovers (Export settings, shadow details), where fields need a caption.
 */
export function InspectorRow({
  label,
  children,
  columns = 2,
  dense = false,
  trailing,
}: {
  label?: string | undefined;
  children: ReactNode;
  columns?: 1 | 2 | 3;
  /** A 6px gap, for rows inside a narrow column (padding beside the alignment pad). */
  dense?: boolean;
  /** A small button after the fields (per-side padding…). */
  trailing?: ReactNode;
}) {
  const fields = (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div
        className={cn(
          "grid min-w-0 flex-1",
          dense ? "gap-1.5" : "gap-2",
          columns === 3 ? "grid-cols-3" : columns === 2 ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {children}
      </div>
      {trailing}
    </div>
  );
  if (label === undefined) return fields;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-16 shrink-0 truncate text-ui-sm text-muted-foreground">{label}</span>
      {fields}
    </div>
  );
}

/**
 * The property row: one field holding a swatch, the value and a detail (opacity or a
 * summary), followed by a remove button. Fill, Text color, Border and Shadow all use it.
 */
export function InspectorPropertyRow({
  children,
  active = false,
  disabled = false,
  removeLabel,
  onRemove,
  className,
}: {
  /** The field's contents: swatch, value and detail. */
  children: ReactNode;
  /** A picker or popover for this row is open; the field keeps its hover gray. */
  active?: boolean;
  disabled?: boolean;
  removeLabel?: string | undefined;
  onRemove?: (() => void) | undefined;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        className={cn(INSPECTOR_FIELD_CLASS_NAME, "flex-1 gap-2 ps-1", className)}
        data-active={active ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
      >
        {children}
      </div>
      {onRemove && removeLabel && !disabled ? (
        <IconButton label={removeLabel} tooltip={removeLabel} className="-mx-1" onClick={onRemove}>
          <MinusIcon />
        </IconButton>
      ) : null}
    </div>
  );
}

/**
 * The row for a list-valued property whose items differ across the selection ("Click to
 * replace mixed fills"): pressing it gives every selected node the first node's list.
 */
export function InspectorMixedRow({
  label,
  disabled = false,
  onReplace,
}: {
  label: string;
  disabled?: boolean;
  onReplace: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={disabled}
      className="w-full justify-start"
      onClick={onReplace}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
}

/** A full-width text action inside a section ("Add flex", "Wrap in flex"). */
export function InspectorActionRow({
  label,
  hint,
  disabled = false,
  onClick,
}: {
  label: string;
  /** A dimmed shortcut after the label. */
  hint?: string | undefined;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="subtle" size="xs" disabled={disabled} className="w-full" onClick={onClick}>
      <span className="truncate">{label}</span>
      {hint ? <span className="shrink-0 font-normal text-muted-foreground">{hint}</span> : null}
    </Button>
  );
}

/** A labelled group inside a section (Flex inside Layout, Layer and Backdrop in Filters). */
export function InspectorSubheader({
  title,
  dimmed = false,
  children,
}: {
  title: string;
  /** The group is empty; its label reads as a placeholder. */
  dimmed?: boolean;
  /** Controls at the end of the row. */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      {/* Below the section's own label: smaller, in the same muted tone, never louder. */}
      <h4
        className={cn(
          "min-w-0 flex-1 truncate text-ui-xs font-normal",
          SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
          dimmed && "opacity-70",
        )}
      >
        {title}
      </h4>
      {children}
    </div>
  );
}

/**
 * Rows reordered by dragging their handle (fill and filter stacks). The handle shows
 * in the section gutter on hover; a list of one has nothing to reorder and shows none.
 */
export function InspectorSortableList({
  ids,
  reorderLabel,
  disabled = false,
  onReorder,
  children,
}: {
  /** One stable key per row, in order. */
  ids: readonly string[];
  reorderLabel: (index: number) => string;
  disabled?: boolean;
  onReorder: (from: number, to: number) => void;
  /** Renders row `index`. */
  children: (index: number) => ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const sortable = ids.length > 1 && !disabled;
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <ul className="flex min-w-0 flex-col gap-1.5">
          {ids.map((id, index) => (
            <SortableRow key={id} id={id} sortable={sortable} handleLabel={reorderLabel(index)}>
              {children(index)}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  sortable,
  handleLabel,
  children,
}: {
  id: string;
  sortable: boolean;
  handleLabel: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !sortable });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("group/sortable relative min-w-0 list-none", isDragging && "z-20 opacity-80")}
    >
      {sortable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={handleLabel}
          className="absolute inset-y-0 -start-3 flex w-3 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 outline-none transition-opacity group-hover/sortable:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon className="size-3" />
        </button>
      ) : null}
      {children}
    </li>
  );
}

// ── Number field ─────────────────────────────────────────────────────────

export type InspectorNumberFieldProps = {
  /** Scrub handle inside the field: a letter ("W") or a small icon. Drag it to scrub. */
  label?: ReactNode;
  /** Trailing text ("%", "Gap"); it scrubs when the field has no leading label. */
  suffix?: ReactNode;
  /** A control at the end of the field, such as the sizing mode chip. */
  trailing?: ReactNode;
  ariaLabel: string;
  /** Numeric base for scrubbing and arrow keys; null when unknown or mixed. */
  value: number | null;
  /** Text shown when not editing (keywords like "Fill"); defaults to the number. */
  text?: string | undefined;
  mixed?: boolean;
  /** Unit for scrubbed values and bare typed numbers ("" for unitless). */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  disabled?: boolean;
  /** No field chrome: the number sits inside another field (a color's opacity). */
  bare?: boolean;
  className?: string;
  inputClassName?: string;
  /** Live DOM update while scrubbing or nudging with the arrow keys. */
  onPreview?: ((value: number) => void) | undefined;
  /** Persist: typed text (Enter or blur), a released scrub, or settled arrow nudges. */
  onCommit: (input: CssInput) => void;
};

/**
 * A compact number field. The label scrubs (Base UI ScrubArea), arrows nudge by 1 (Shift 8,
 * Alt 0.1), and typing accepts units, keywords and arithmetic ("12px", "50%",
 * "auto", "24*2"), which Base UI's own numeric input would reject, so its text handlers are
 * bypassed.
 */
export function InspectorNumberField({
  label,
  suffix,
  trailing,
  ariaLabel,
  value,
  text,
  mixed = false,
  unit = "px",
  min = -100_000,
  max = 100_000,
  step = 1,
  largeStep = largeStepFor(step),
  disabled = false,
  bare = false,
  className,
  inputClassName,
  onPreview,
  onCommit,
}: InspectorNumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [nudged, setNudged] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  /** A scrub moved the value; previews already show it, so compare nothing on release. */
  const scrubbed = useRef(false);
  /** Escape discards the draft; the blur it causes must not commit it. */
  const discardOnBlur = useRef(false);
  const latestCommit = useRef(onCommit);
  const latestUnit = useRef(unit);
  useEffect(() => {
    latestCommit.current = onCommit;
    latestUnit.current = unit;
  });

  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null)
      latestCommit.current({ kind: "length", value: next, unit: latestUnit.current });
  };
  // A nudge still waiting when the field goes away belongs to the layers it previewed.
  useEffect(() => () => flush(), []);

  // Once the stored value catches up with a scrub or nudge, show the stored value again.
  useEffect(() => {
    if (pending.current === null) setNudged(null);
  }, [value]);

  const shown =
    draft ??
    (nudged !== null
      ? formatNumber(nudged)
      : mixed
        ? ""
        : (text ?? (value === null ? "" : formatNumber(value))));

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = parseCssInput(draft, unit);
    setDraft(null);
    if (parsed) onCommit(parsed);
  };

  const nudge = (direction: 1 | -1, amount: number) => {
    const typed = draft === null ? null : parseCssInput(draft, unit);
    const base = typed?.kind === "length" ? typed.value : (pending.current ?? nudged ?? value ?? 0);
    const next = clamp(Number(formatNumber(base + direction * amount)), min, max);
    setDraft(null);
    setNudged(next);
    onPreview?.(next);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, NUDGE_COMMIT_DELAY_MS);
  };

  return (
    <NumberFieldPrimitive.Root
      value={nudged ?? value}
      min={min}
      max={max}
      step={step}
      largeStep={largeStep}
      smallStep={0.1}
      disabled={disabled}
      onValueChange={(next, details) => {
        if (details.reason !== "scrub" || next === null) return;
        scrubbed.current = true;
        setNudged(next);
        onPreview?.(next);
      }}
      onValueCommitted={(next, details) => {
        if (details.reason !== "scrub") return;
        const moved = scrubbed.current;
        scrubbed.current = false;
        if (moved && next !== null) onCommit({ kind: "length", value: next, unit });
      }}
      className={cn(
        bare ? "flex min-w-0 items-center" : INSPECTOR_FIELD_CLASS_NAME,
        // The field's icon lane: a label sits centred in the field's first 24px.
        !bare && label !== undefined && "gap-0 ps-0",
        trailing !== undefined && "pe-1",
        className,
      )}
    >
      {label !== undefined ? <ScrubHandle lane={!bare}>{label}</ScrubHandle> : null}
      <NumberFieldPrimitive.Input
        aria-label={ariaLabel}
        className={cn(INSPECTOR_INPUT_CLASS_NAME, inputClassName)}
        value={shown}
        placeholder={mixed ? "–" : undefined}
        onFocus={(event) => {
          // Base UI moves the caret to the end on first focus; select the value instead.
          event.preventBaseUIHandler();
          event.currentTarget.select();
        }}
        onChange={(event) => {
          event.preventBaseUIHandler();
          setDraft(event.currentTarget.value);
        }}
        onPaste={(event) => event.preventBaseUIHandler()}
        onBlur={(event) => {
          event.preventBaseUIHandler();
          if (discardOnBlur.current) discardOnBlur.current = false;
          else commitDraft();
          flush();
        }}
        onKeyDown={(event) => {
          event.preventBaseUIHandler();
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
            flush();
            event.currentTarget.select();
          } else if (event.key === "Escape") {
            setDraft(null);
            discardOnBlur.current = true;
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            nudge(
              event.key === "ArrowUp" ? 1 : -1,
              event.shiftKey ? largeStep : event.altKey ? 0.1 : step,
            );
          }
        }}
      />
      {suffix === undefined ? null : label === undefined ? (
        <ScrubHandle>{suffix}</ScrubHandle>
      ) : (
        <span className="shrink-0 select-none text-muted-foreground">{suffix}</span>
      )}
      {trailing}
    </NumberFieldPrimitive.Root>
  );
}

function ScrubHandle({ children, lane = false }: { children: ReactNode; lane?: boolean }) {
  return (
    <NumberFieldPrimitive.ScrubArea
      className={cn(
        "flex h-full shrink-0 cursor-ew-resize select-none items-center text-muted-foreground",
        lane && "w-6 justify-center",
      )}
      pixelSensitivity={2}
    >
      {children}
      <NumberFieldPrimitive.ScrubAreaCursor className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.4)]">
        <CentralIcon name="arrow-left-right" className="size-4 text-foreground" />
      </NumberFieldPrimitive.ScrubAreaCursor>
    </NumberFieldPrimitive.ScrubArea>
  );
}

/** A letter label for number fields ("X", "W"), in the field's icon lane. */
export function FieldLetter({ children }: { children: ReactNode }) {
  return <span className="text-ui-xs font-medium">{children}</span>;
}

/** A Central icon used as a field label or toggle glyph. */
export function InspectorIcon({ name, className }: { name: string; className?: string }) {
  return <CentralIcon name={name} className={cn("size-3.5", className)} />;
}

// ── Toggles ──────────────────────────────────────────────────────────────

export type ToggleOption<T extends string> = {
  value: T;
  label: string;
  icon: ReactNode;
  /** The tooltip, when it says more than the label (its shortcut). */
  tooltip?: ReactNode;
};

/** Icon options that pick one value (direction, alignment…): the app's segmented picker. */
export function InspectorToggleGroup<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false,
  className,
}: {
  value: T | null;
  options: ReadonlyArray<ToggleOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Sized to its icons rather than its column (a header's direction toggle). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <SegmentedPicker<T>
      size="sm"
      shape="field"
      iconOnly
      ariaLabel={ariaLabel}
      value={value}
      disabled={disabled}
      options={options}
      onValueChange={onChange}
      className={cn(compact && "w-auto shrink-0", className)}
    />
  );
}

/** One pressable icon with a tooltip: the app's xs toggle. */
export function InspectorToggle({
  label,
  pressed,
  disabled = false,
  onPressedChange,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled?: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="xs"
            pressed={pressed}
            disabled={disabled}
            aria-label={label}
            onPressedChange={onPressedChange}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

// ── Select ───────────────────────────────────────────────────────────────

export type SelectOption<T extends string> = { value: T; label: string };

export function InspectorSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  mixed = false,
  chip = false,
  className,
}: {
  value: T | null;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  mixed?: boolean;
  /** A small muted chip inside another field (W/H sizing mode), not a field of its own. */
  chip?: boolean;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Select
      value={mixed ? null : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next as T);
      }}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size={chip ? "chip" : "xs"}
        variant={chip ? "ghost" : "filled"}
        className={cn("min-w-0", chip ? "w-auto shrink-0" : "w-full", className)}
      >
        <SelectValue className="truncate text-start">
          {mixed ? "–" : (current?.label ?? value ?? "")}
        </SelectValue>
      </SelectTrigger>
      <ComposerPickerSelectPopup align="start">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </ComposerPickerSelectPopup>
    </Select>
  );
}

// ── Checkbox row ─────────────────────────────────────────────────────────

export function InspectorCheckbox({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-6 min-w-0 cursor-default items-center gap-2 text-ui-sm text-foreground">
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="truncate">{label}</span>
    </label>
  );
}
