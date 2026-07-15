// FILE: chatHeaderControls.tsx
// Purpose: Single source of truth for chat-header toolbar control sizing, radius,
//          and tone so text buttons, icon-only buttons, and toggles line up on one
//          baseline regardless of the underlying Button/Toggle variant.
// Layer: Chat header UI primitive
// Exports: ChatHeaderButton, ChatHeaderIconButton, tone helper, and the raw class
//          tokens for call sites that can't use the wrappers (e.g. Toggle, segmented
//          groups, render-prop triggers, right-dock tabs).
// Why: The header previously mixed three heights (24/28/32px) and two radii because
//      each control leaned on a different Button size + variant compound. Centralizing
//      the chrome here keeps the row visually coherent and lets new controls opt in
//      with one import instead of re-deriving the magic classes.

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";

import { CentralIcon } from "~/lib/central-icons";
import { type LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

/**
 * Fixed height of the top chrome bar shared by the chat header, the diff panel
 * header, and the right-dock tab strip. Keeping these on one token ensures their
 * bottom borders line up across the vertical pane divider.
 *
 * Tall enough that the vertically-centered controls clear the macOS title bar with
 * breathing room below them rather than hugging the very top of the window.
 *
 * The pixel height is owned by `CHAT_SURFACE_HEADER_HEIGHT_PX` in
 * `@synara/shared/desktopChrome` (the single source of truth the Electron main
 * process also reads to center the native traffic lights). Tailwind only emits CSS
 * for class names it can scan literally, so the class stays a literal here — but its
 * TYPE is derived from the shared number, so the build fails if the two ever drift.
 */
export const CHAT_SURFACE_HEADER_HEIGHT_CLASS: `h-[${typeof CHAT_SURFACE_HEADER_HEIGHT_PX}px]` =
  "h-[46px]";

/**
 * Standard horizontal inset for a chat-surface top bar (chat / workspace / settings
 * headers all sit their content at this x). Kept as one token so the leading controls
 * line up across surfaces and the inset is tuned in a single place.
 */
export const CHAT_SURFACE_HEADER_PADDING_X_CLASS = "px-3 sm:px-5";

/**
 * Bottom hairline shared by every chat-surface chrome bar (chat header, workspace
 * header, dock pane + tab strip headers, diff panel header).
 * Implemented as the `.chat-surface-divider` component class (a 1px background gradient,
 * see index.css) rather than a CSS border: it reads from the SAME `--app-surface-divider`
 * token as the vertical sidebar↔chat seam, and — because it's a gradient — the seam corner
 * retracts it 1px so the horizontal hairline butts against the vertical seam instead of
 * crossing it (overlapping 1px lines double their alpha into a brighter dot). Apply
 * alongside {@link CHAT_SURFACE_HEADER_HEIGHT_CLASS} so heights and dividers line up.
 */
export const CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME = "chat-surface-divider";

/**
 * Standard chat-surface chrome-bar row: the shared flex baseline + fixed height + bottom
 * hairline that the simple headers all repeat (empty-state chat header, dock pane header,
 * right-dock tab strip). Call sites add only their own gap/padding
 * and extras (drag-region, traffic-light gutter). Headers with bespoke layout (the main
 * chat header with its split toolbar, the diff panel header with `justify-between`) compose
 * {@link CHAT_SURFACE_HEADER_HEIGHT_CLASS} + {@link CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME}
 * directly instead of forcing this baseline.
 */
export const CHAT_SURFACE_HEADER_ROW_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
);

/**
 * Force header control glyphs to full-strength foreground. The base Button caps
 * SVGs at `opacity-80` and the `chrome` variant tints them with the muted
 * `foreground-secondary` color, which together read as washed-out gray icons in
 * the toolbar. Header buttons want crisp, solid icons, so we override both the
 * icon opacity and the inherited `currentColor` here.
 */
export const CHAT_HEADER_ICON_STRENGTH_CLASS_NAME =
  "text-[var(--color-text-foreground)] [&_svg]:!opacity-100";

/** Fixed control height + radius for every header toolbar control. */
export const CHAT_HEADER_CONTROL_CLASS_NAME = "!h-7 shrink-0 rounded-lg";

/** Idle text tone for flat header/dock controls (toggles, tabs, chrome icon buttons). */
export const CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME =
  "text-[var(--color-text-foreground-secondary)]";

/** Active/pressed flat background shared by header toggles and dock tabs. */
export const CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME =
  "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]";

/** Hover treatment for idle flat surface controls. */
export const CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME =
  "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

/**
 * Shared flat "chip" skin for the header diff toggle and the right-dock tabs so
 * the two read as the exact same control: 28px tall, lg radius, no border, ui-sm
 * muted text that brightens + fills on hover, with a smooth color transition.
 * The active (pressed/selected) background is layered on per call site because
 * the mechanism differs (Toggle `data-pressed` vs the dock tab's `active` flag),
 * but both resolve to `--color-background-button-secondary`.
 */
export const CHAT_SURFACE_CHIP_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "gap-1.5 border-0 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] font-normal transition-colors",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
);

/**
 * Geometry shared by every chip glyph, muting excluded. Status glyphs (a pull
 * request's state, say) carry meaning in their color and want this one: fading
 * them washes the signal out, which is exactly what a chrome icon wants and a
 * status icon never does.
 */
export const CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME = "size-3.5 shrink-0";

/**
 * Icon treatment shared by every chrome chip glyph (the header diff toggle + the
 * dock tabs) so size and muted strength stay identical. Color rides `currentColor`,
 * which both chips drive to `--color-text-foreground-secondary` at rest, so the
 * tint is inherited from the chip instead of redeclared per call site.
 */
export const CHAT_SURFACE_CHIP_ICON_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME,
  "opacity-70",
);

/** Renders any chip glyph with the shared {@link CHAT_SURFACE_CHIP_ICON_CLASS_NAME} treatment. */
export function SurfaceChipIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return <Icon aria-hidden className={cn(CHAT_SURFACE_CHIP_ICON_CLASS_NAME, className)} />;
}

/** Header diff toggle — shared chip skin + Toggle's pressed text treatment. */
export const CHAT_HEADER_TOGGLE_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_CLASS_NAME,
  "data-pressed:text-[var(--color-text-foreground)]",
);

/** Flat dock tab chip — shares the header diff toggle chrome, but adds one extra
 *  step of right padding (`px-1.5` → `pr-2.5`) so the label/trailing edge has a
 *  touch more breathing room than the symmetric chip base. */
export const DOCK_TAB_CHIP_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_CLASS_NAME,
  "inline-flex min-w-0 items-center pr-2.5",
);

/** Icon slot for dock tabs — bare larger icon at rest; on hover a circular disc + X appears.
 *  Color is muted while the tab (not the close button) is hovered and brightens to full
 *  foreground on direct hover of the close button so the X reads as interactive. */
export const DOCK_TAB_ICON_SLOT_CLASS_NAME =
  "relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent text-[var(--color-text-foreground-secondary)] transition-colors group-hover/dock-tab:bg-[var(--color-background-button-secondary-hover)] group-focus-within/dock-tab:bg-[var(--color-background-button-secondary-hover)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]";

/** Dock-only extra: fade the resting glyph out so the hover X can swap in.
 *  Layered on top of {@link SurfaceChipIcon}'s shared size/strength. */
export const DOCK_TAB_ICON_HOVER_HIDE_CLASS_NAME =
  "transition-opacity group-hover/dock-tab:opacity-0 group-focus-within/dock-tab:opacity-0";

/** Hover glyph: thicker X centered inside the disc. */
export const DOCK_TAB_CLOSE_GLYPH_CLASS_NAME =
  "absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/dock-tab:opacity-100 group-focus-within/dock-tab:opacity-100";

/**
 * Shared flat tab chip for every chat surface that renders a row of closable tabs —
 * the right-dock tab strip and both terminal tab bars (pane-local tabs + workspace
 * group tabs). At rest the chip shows {@link icon}; hovering or focusing within the
 * chip fades that glyph out and reveals a circular close affordance, but only when
 * an {@link onClose} handler is supplied (tabs that can't be closed render a static
 * icon slot instead).
 *
 * The icon→close-X reveal is driven entirely by the `group/dock-tab` named group
 * the chip declares here, so the hover wiring lives in exactly one place. Call
 * sites that hand-rolled the chip previously drifted to a mismatched group name
 * (`group/tab`), which silently broke the reveal — funneling them through this
 * component makes that class of bug unrepresentable.
 *
 * `leading`/`trailing` flank the truncating label (e.g. an activity indicator or a
 * tab count badge); `labelClassName` lets a call site cap the label width.
 */
export function SurfaceTabChip({
  icon,
  label,
  active,
  title,
  leading,
  trailing,
  className,
  labelClassName,
  closeLabel,
  onSelect,
  onClose,
}: {
  icon: ReactNode;
  label: ReactNode;
  active?: boolean | undefined;
  title?: string | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string | undefined;
  labelClassName?: string | undefined;
  closeLabel?: string | undefined;
  onSelect?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  return (
    <div
      className={cn(
        "group/dock-tab",
        DOCK_TAB_CHIP_CLASS_NAME,
        active && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
        className,
      )}
    >
      {onClose ? (
        <button
          type="button"
          className={DOCK_TAB_ICON_SLOT_CLASS_NAME}
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <span
            className={cn("flex items-center justify-center", DOCK_TAB_ICON_HOVER_HIDE_CLASS_NAME)}
          >
            {icon}
          </span>
          <CentralIcon name="cross-small" className={DOCK_TAB_CLOSE_GLYPH_CLASS_NAME} />
        </button>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      {onSelect ? (
        <button
          type="button"
          className={cn("flex min-w-0 items-center gap-1.5 text-left", labelClassName)}
          title={title}
          aria-pressed={active}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          {leading}
          <span className="truncate">{label}</span>
          {trailing}
        </button>
      ) : (
        // Non-selectable chips (a lone tab that cannot switch to anything) render the
        // label as static text so keyboard/AT users don't land on a button that does
        // nothing.
        <span
          className={cn("flex min-w-0 items-center gap-1.5 text-left", labelClassName)}
          title={title}
        >
          {leading}
          <span className="truncate">{label}</span>
          {trailing}
        </span>
      )}
    </div>
  );
}

export const CHAT_HEADER_ICON_CONTROL_CLASS_NAME =
  "!size-7 shrink-0 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0";

/**
 * Square chrome icon-button footprint shared by every right-dock header — the tab
 * strip controls (add/collapse) and each pane's title-bar actions (close/refresh/…).
 * Aliases {@link CHAT_HEADER_ICON_CONTROL_CLASS_NAME} so dock header buttons stay the
 * same 28px size as the chat header instead of drifting to 24px (icon-xs) per surface.
 */
export const DOCK_HEADER_ICON_BUTTON_CLASS = CHAT_HEADER_ICON_CONTROL_CLASS_NAME;

/** Flatten the trailing edge of a split-button's leading control so it butts up
 *  against the shared divider (drops the end radius + the doubled end border). */
export const CHAT_HEADER_SPLIT_LEADING_CLASS_NAME = "rounded-e-none border-e-0";

/** Flatten the leading edge of a split-button's trailing (chevron) control. */
export const CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME = "rounded-s-none border-s-0";

/**
 * Container for a header split-button: a leading action, the shared
 * {@link ChatHeaderSplitDivider}, and a trailing menu trigger, all sharing one
 * rounded chrome footprint. Used by the git action control and the editor picker
 * so both split buttons look identical.
 */
export function ChatHeaderSplitGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex items-stretch", className)}>
      {children}
    </div>
  );
}

/** Hairline separator between a split-button's leading and trailing controls. */
export function ChatHeaderSplitDivider() {
  return <div aria-hidden="true" className="w-px self-stretch bg-border" />;
}

export type DiffRenderMode = "stacked" | "split";

/** Visual treatment shared across the header row. */
export type ChatHeaderControlTone = "plain" | "outline";

/** Maps a header tone onto the shared Button variant taxonomy. */
export function chatHeaderControlVariant(
  tone: ChatHeaderControlTone,
): NonNullable<ComponentProps<typeof Button>["variant"]> {
  return tone === "outline" ? "chrome-outline" : "chrome";
}

type ChatHeaderButtonBaseProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  tone?: ChatHeaderControlTone;
};

/**
 * Text (or text + icon) header control. Safe to use directly or as a
 * Menu/Tooltip `render` target since it forwards the ref and spreads props.
 */
export const ChatHeaderButton = forwardRef<HTMLButtonElement, ChatHeaderButtonBaseProps>(
  function ChatHeaderButton({ tone = "outline", className, ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        size="xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(
          CHAT_HEADER_CONTROL_CLASS_NAME,
          CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
          className,
        )}
      />
    );
  },
);

type ChatHeaderIconButtonBaseProps = Omit<
  ComponentProps<typeof Button>,
  "variant" | "size" | "aria-label"
> & {
  label: string;
  tone?: ChatHeaderControlTone;
  children?: ReactNode;
};

/**
 * Square icon-only header control. Renders only a Button (no built-in tooltip)
 * so it composes with the existing Tooltip/Menu `render` wrappers used in the header.
 */
export const ChatHeaderIconButton = forwardRef<HTMLButtonElement, ChatHeaderIconButtonBaseProps>(
  function ChatHeaderIconButton({ label, tone = "plain", className, children, ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        aria-label={label}
        size="icon-xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(
          CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
          CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
          className,
        )}
      >
        {children}
      </Button>
    );
  },
);
