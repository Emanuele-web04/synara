// FILE: controls.tsx
// Purpose: The HoloBot kit's small controls (ported from HoloBot's packages/ui Button.tsx,
//          IconButton.tsx, Chip.tsx, Text.tsx, TextField.tsx, Switch.tsx, Segmented.tsx,
//          Field.tsx, Panel.tsx and DragStrip.tsx): capsule buttons (a primary one is a dark core
//          inside a thin ring of HoloBot's moving liquid metal), round icon buttons, chips,
//          counts and dots, text styles, a capsule text field, a switch, a segmented choice, a
//          titled field, a pane and a pane's top strip.
// Layer: SynBot kit
// Exports: CapsuleButton, ButtonKind, IconButton, Chip, Tone, CountBadge, Badged, Dot, DotTone,
//          Text, TextField, Switch, Segmented, SegmentedOption, Field, Pane, Strip

import {
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { Icon, type IconName } from "./Icon";
import { LiquidMetal } from "./metal/Metal";
import "./holobot.css";

const classes = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).join(" ");

// ── Buttons ──────────────────────────────────────────────────────────

/** primary: a dark core in a ring of moving liquid metal (none while disabled); normal,
 * danger, card, ghost: flat capsules. */
export type ButtonKind = "primary" | "normal" | "danger" | "card" | "ghost";

export function CapsuleButton({
  kind,
  chosen,
  round,
  compact,
  small,
  className,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly kind: ButtonKind;
  /** The answer that was chosen: keeps full opacity and an outline. */
  readonly chosen?: boolean | undefined;
  readonly round?: boolean | undefined;
  /** A 28 px pill. */
  readonly compact?: boolean | undefined;
  /** A 24 px pill. */
  readonly small?: boolean | undefined;
  readonly ref?: Ref<HTMLButtonElement> | undefined;
  readonly children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={classes(
        "hb-btn",
        `hb-btn--${kind}`,
        round && "hb-btn--round",
        compact && "hb-btn--compact",
        small && "hb-btn--small",
        className,
      )}
      data-chosen={chosen || undefined}
      {...rest}
    >
      {kind === "primary" && !rest.disabled ? <LiquidMetal moving round={round} /> : null}
      <span className="hb-btn__core">{children}</span>
    </button>
  );
}

/** A circular icon button on the card fill, or ghost. The label is its name and tooltip. */
export function IconButton({
  icon,
  label,
  kind = "card",
  className,
  ref,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  readonly icon: IconName;
  readonly label: string;
  readonly kind?: "card" | "ghost";
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={classes("hb-icon-btn", `hb-icon-btn--${kind}`, className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

// ── Chips, counts and dots ───────────────────────────────────────────

/** Color family of a chip. */
export type Tone = "muted" | "active" | "attention" | "good" | "bad";

export function Chip({
  tone,
  dot,
  icon,
  leading,
  title,
  className,
  children,
}: {
  readonly tone: Tone;
  readonly dot?: boolean | undefined;
  readonly icon?: IconName | undefined;
  /** A mark of its own before the label (a provider's logo). */
  readonly leading?: ReactNode;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <span className={classes("hb-chip", `hb-chip--${tone}`, className)} title={title}>
      {dot ? <span className="hb-chip__dot" /> : null}
      {icon ? <Icon name={icon} size="xs" /> : null}
      {leading}
      <span className="hb-chip__label">{children}</span>
    </span>
  );
}

/** A count in a small attention capsule; nothing for zero. */
export function CountBadge({ count, label }: { readonly count: number; readonly label?: string }) {
  if (count <= 0) return null;
  return (
    <span className="hb-count" aria-label={label ?? String(count)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** `children` (an icon button) with its CountBadge on the top-right corner. */
export function Badged({
  count,
  label,
  children,
}: {
  readonly count: number;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="hb-badged">
      {children}
      <CountBadge count={count} {...(label ? { label } : {})} />
    </span>
  );
}

export type DotTone = Tone;

export function Dot({ tone, small }: { readonly tone: DotTone; readonly small?: boolean }) {
  return <span className={`hb-dot hb-dot--${tone}${small ? " hb-dot--sm" : ""}`} aria-hidden />;
}

// ── Text ─────────────────────────────────────────────────────────────

export type TextVariant = "title" | "heading" | "body" | "label" | "small" | "caption";
export type TextTone = "default" | "soft" | "muted" | "attention" | "bad";

export function Text({
  variant,
  tone = "default",
  as: Tag = "p",
  truncate,
  className,
  children,
}: {
  readonly variant: TextVariant;
  readonly tone?: TextTone;
  readonly as?: "p" | "span" | "div" | "h1" | "h2" | "h3";
  /** One line, cut with an ellipsis. */
  readonly truncate?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Tag
      className={classes(
        "hb-text",
        `hb-text--${variant}`,
        tone !== "default" && `hb-text--${tone}`,
        truncate && "hb-text--truncate",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

// ── Fields ───────────────────────────────────────────────────────────

/** A one-line text field in a capsule: Enter calls `onEnter` (not while composing). */
export function TextField({
  value,
  onChange,
  onEnter,
  invalid,
  className,
  onKeyDown,
  ref,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onEnter?: () => void;
  readonly invalid?: boolean;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}) {
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.key === "Enter" && !event.nativeEvent.isComposing && onEnter) {
      event.preventDefault();
      onEnter();
    }
  };
  return (
    <input
      ref={ref}
      type="text"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className={classes("hb-input", className)}
      aria-invalid={invalid || undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={keyDown}
      {...rest}
    />
  );
}

/** An on/off switch: a capsule track with a round knob. */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="hb-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="hb-switch__knob" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** One choice among a few, the current one highlighted; a radio group (arrow keys move). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  readonly value: T | null;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  /** Accessible name of the group (the setting's name). */
  readonly label: string;
  readonly disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const at = options.findIndex((option) => option.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      ref={group}
      className="hb-segmented"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            tabIndex={selected || (value === null && index === 0) ? 0 : -1}
            className="hb-segmented__option"
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A titled part of a form: a small title, an optional hint under it, then the control. */
export function Field({
  title,
  hint,
  className,
  children,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={classes("hb-field", className)} aria-labelledby={id}>
      <div>
        <Text variant="label" as="h3">
          <span id={id}>{title}</span>
        </Text>
        {hint ? (
          <Text variant="small" tone="muted">
            {hint}
          </Text>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// ── Panes ────────────────────────────────────────────────────────────

/** A pane of the window: a column filling its height, a hairline on the side it borders. */
export function Pane({
  edge = "none",
  width = "fill",
  className,
  ref,
  children,
}: {
  readonly edge?: "left" | "none";
  readonly width?: "sessions" | "fill";
  readonly className?: string;
  readonly ref?: Ref<HTMLElement>;
  readonly children: ReactNode;
}) {
  return (
    <section
      ref={ref}
      className={classes(
        "hb-pane",
        `hb-pane--${width}`,
        edge !== "none" && `hb-pane--edge-${edge}`,
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A pane's top strip: `leading` left, `center` in the middle, `trailing` right. */
export function Strip({
  leading,
  center,
  trailing,
  className,
}: {
  readonly leading?: ReactNode;
  readonly center?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={classes("hb-strip", className)}>
      <div className="hb-strip__leading">{leading}</div>
      <div className="hb-strip__center">{center}</div>
      <div className="hb-strip__trailing">{trailing}</div>
    </header>
  );
}
