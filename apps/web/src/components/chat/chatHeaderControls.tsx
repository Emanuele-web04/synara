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

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

/**
 * Fixed height of the top chrome bar shared by the chat header, the diff panel
 * header, and the right-dock tab strip. Keeping these on one token ensures their
 * bottom borders line up across the vertical pane divider.
 */
export const CHAT_SURFACE_HEADER_HEIGHT_CLASS = "h-[46px]";

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

/** Muted icon tone for inactive header toggles (matches chrome icon buttons). */
export const CHAT_HEADER_TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "border-0",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  "data-pressed:text-[var(--color-text-foreground)]",
);

/** Flat dock tab chip — same radius, height, and classic background as header panel toggles. */
export const DOCK_TAB_CHIP_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "inline-flex min-w-0 items-center gap-1.5 border-0 bg-transparent px-2 text-[length:var(--app-font-size-ui-sm,11px)] font-normal transition-colors",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
);

/** Icon slot for dock tabs — bare larger icon at rest; on hover a circular disc + X appears.
 *  Color is muted while the tab (not the close button) is hovered and brightens to full
 *  foreground on direct hover of the close button so the X reads as interactive. */
export const DOCK_TAB_ICON_SLOT_CLASS_NAME =
  "relative flex size-4 shrink-0 items-center justify-center rounded-full bg-transparent text-[var(--color-text-foreground-secondary)] transition-colors group-hover/dock-tab:bg-[var(--color-background-button-secondary-hover)] group-focus-within/dock-tab:bg-[var(--color-background-button-secondary-hover)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]";

/** Resting glyph: full-size tab icon, no disc, slightly muted until hovered. */
export const DOCK_TAB_ICON_GLYPH_CLASS_NAME =
  "size-3.5 shrink-0 opacity-55 transition-opacity group-hover/dock-tab:opacity-0 group-focus-within/dock-tab:opacity-0";

/** Hover glyph: thicker X centered inside the disc. */
export const DOCK_TAB_CLOSE_GLYPH_CLASS_NAME =
  "absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/dock-tab:opacity-100 group-focus-within/dock-tab:opacity-100";
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
        className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, className)}
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
        className={cn(CHAT_HEADER_ICON_CONTROL_CLASS_NAME, className)}
      >
        {children}
      </Button>
    );
  },
);
