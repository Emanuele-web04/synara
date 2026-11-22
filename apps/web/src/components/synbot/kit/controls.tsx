// FILE: controls.tsx
// Purpose: The HoloBot kit's small controls (ported from HoloBot's packages/ui Button.tsx,
//          IconButton.tsx, Chip.tsx, Text.tsx, TextField.tsx, Field.tsx, Panel.tsx and
//          DragStrip.tsx): capsule buttons (a primary one is a dark core inside a thin ring of
//          HoloBot's liquid metal, which moves only under the pointer or the keyboard's focus),
//          the composer Send's metal ring, round icon buttons, chips, counts and dots, text
//          styles, a capsule text field, a titled field, a pane and a pane's top strip. Switches
//          and choices are Synara's own (ui/switch, the settings controls).
// Layer: SynBot kit
// Exports: CapsuleButton, ButtonKind, SendRing, IconButton, Chip, Tone, Dot, DotTone, Text,
//          TextField, Field, Pane, Strip

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { Icon, type IconName } from "./Icon";
import { LiquidMetal } from "~/components/ui/metal/LiquidMetal";
import "./holobot.css";

const classes = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).join(" ");

// ── Buttons ──────────────────────────────────────────────────────────

/** Whether the control holding `anchor` is under the pointer or has the keyboard's focus. */
function useControlLit(anchor: RefObject<HTMLElement | null>): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const control = anchor.current?.closest("button");
    if (!control) return;
    const on = () => setLit(true);
    const off = () => setLit(control.matches(":hover"));
    const focus = () => setLit(control.matches(":focus-visible"));
    control.addEventListener("pointerenter", on);
    control.addEventListener("pointerleave", off);
    control.addEventListener("focusin", focus);
    control.addEventListener("focusout", off);
    return () => {
      control.removeEventListener("pointerenter", on);
      control.removeEventListener("pointerleave", off);
      control.removeEventListener("focusin", focus);
      control.removeEventListener("focusout", off);
    };
  }, [anchor]);
  return lit;
}

/** A primary capsule's metal: one still frame until its button is pointed at or focused. */
function CapsuleMetal({ round }: { readonly round: boolean | undefined }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const lit = useControlLit(anchor);
  return (
    <span ref={anchor} className="hb-btn__metal">
      <LiquidMetal moving={lit} round={round} />
    </span>
  );
}

/** The composer's Send in a bot chat: HoloBot's dark core in a ring of liquid metal (ui/metal's
 * ring). The metal moves while `moving` (a message on its way) or while Send is pointed at or
 * focused; otherwise it holds one frame. Pass it as the composer's `composerSendUnderlay`. */
export function SendRing({ moving = false }: { readonly moving?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const lit = useControlLit(anchor);
  return (
    <span ref={anchor} className="ui-metal-ring" aria-hidden>
      <LiquidMetal moving={moving || lit} round />
      <span className="ui-metal-ring__core" />
    </span>
  );
}

/** primary: a dark core in a ring of liquid metal that moves under the pointer or the
 * keyboard's focus (no metal while disabled); normal, danger, card, ghost: flat capsules. */
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
      {kind === "primary" && !rest.disabled ? <CapsuleMetal round={round} /> : null}
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
