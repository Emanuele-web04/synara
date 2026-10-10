import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { IconButton } from "../ui/icon-button";
import type { TooltipPopup } from "../ui/tooltip";

// sized off the footer's font-size so glyphs scale with the chat type scale and stay under 1em — quiet affordances, not text competitors
// turn-footer actions sit at rest carrying full muted-foreground tint; the reference for MUTED_LABEL_TEXT_CLASS_NAME so transcript quiet labels share the token
export const MESSAGE_ACTION_ICON_CLASS_NAME = "size-[1.125em] opacity-100";

export const MESSAGE_ACTION_BUTTON_CLASS_NAME = `size-[2em] shrink-0 rounded-none border-0 bg-transparent p-0 font-system-ui font-normal leading-none text-[length:inherit] ${MUTED_LABEL_TEXT_CLASS_NAME} shadow-none transition-colors hover:bg-transparent [:hover,[data-pressed]]:bg-transparent data-pressed:bg-transparent hover:text-foreground [:hover,[data-pressed]]:text-foreground focus-visible:ring-0 disabled:cursor-default disabled:opacity-40 [&_svg:not([class*='size-'])]:size-[1.125em] [&_svg]:opacity-100`;

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
