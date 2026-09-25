// FILE: MessageActionButton.tsx
// Purpose: Shared icon button chrome for compact message actions.
// Layer: Web chat presentation component
// Exports: MessageActionButton

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { IconButton } from "../ui/icon-button";
import type { TooltipPopup } from "../ui/tooltip";

// Message actions sit at rest (no hover reveal) on the turn footer, so they carry the
// full `muted-foreground` tint rather than a faded one and darken to `foreground` on
// hover. Sized off the footer's own font-size so they scale with the chat type scale,
// and kept just under 1em so the glyphs read as quiet affordances rather than competing
// with the text next to them.
//
// This bar is the reference for MUTED_LABEL_TEXT_CLASS_NAME — the transcript's quiet
// labels ("Worked for", "Thinking", tool rows) are read against it, so it pulls the
// tint from that shared token instead of restating the class.
export const MESSAGE_ACTION_ICON_CLASS_NAME = "size-[1.125em] opacity-100";

export const MESSAGE_ACTION_BUTTON_CLASS_NAME = `size-[2em] min-h-6 min-w-6 shrink-0 rounded-none border-0 bg-transparent p-0 font-system-ui font-normal leading-none text-[length:inherit] ${MUTED_LABEL_TEXT_CLASS_NAME} shadow-none transition-colors hover:bg-transparent [:hover,[data-pressed]]:bg-transparent data-pressed:bg-transparent hover:text-foreground [:hover,[data-pressed]]:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-40 [&_svg:not([class*='size-'])]:size-[1.125em] [&_svg]:opacity-100`;

// The transcript's recurring quiet text buttons ("Show N more tool calls", row
// disclosure chevrons, chip toggles) share one floor: a 24px minimum target and
// the shared ring instead of the browser's default outline.
export const TRANSCRIPT_TEXT_BUTTON_CLASS_NAME =
  "min-h-6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60";

type MessageActionButtonProps = Omit<
  ComponentProps<"button">,
  "aria-label" | "children" | "title"
> & {
  children: ReactNode;
  label: string;
  tooltip: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipPopup>["side"];
};

export const MessageActionButton = forwardRef<HTMLButtonElement, MessageActionButtonProps>(
  function MessageActionButton(
    { children, className, label, tooltip, tooltipSide: tooltipSideProp, type: typeProp, ...props },
    ref,
  ) {
    const tooltipSide = tooltipSideProp ?? "top";
    const type = typeProp ?? "button";
    return (
      <IconButton
        {...props}
        ref={ref}
        type={type}
        label={label}
        tooltip={tooltip}
        tooltipSide={tooltipSide}
        className={cn(MESSAGE_ACTION_BUTTON_CLASS_NAME, className)}
        size="icon-xs"
        variant="ghost"
      >
        {children}
      </IconButton>
    );
  },
);
