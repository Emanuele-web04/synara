// FILE: chatHeaderControls.tsx
// Purpose: Single source of truth for chat-header toolbar control sizing, radius,
//          and tone so text buttons, icon-only buttons, and toggles line up on one
//          baseline regardless of the underlying Button/Toggle variant.
// Layer: Chat header UI primitive
// Exports: ChatHeaderButton, ChatHeaderIconButton, tone helper, and the raw class
//          tokens for call sites that can't use the wrappers (e.g. Toggle, segmented
//          groups, render-prop triggers).
// Why: The header previously mixed three heights (24/28/32px) and two radii because
//      each control leaned on a different Button size + variant compound. Centralizing
//      the chrome here keeps the row visually coherent and lets new controls opt in
//      with one import instead of re-deriving the magic classes.

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

/** Fixed control height + radius for every header toolbar control. */
export const CHAT_HEADER_CONTROL_CLASS_NAME = "!h-7 shrink-0 rounded-lg";

/** Square footprint for icon-only header controls (height-matched, centered glyph). */
export const CHAT_HEADER_ICON_CONTROL_CLASS_NAME = "!size-7 shrink-0 rounded-lg [&_svg]:mx-0";

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
