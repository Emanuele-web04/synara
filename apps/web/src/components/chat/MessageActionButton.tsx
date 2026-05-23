// FILE: MessageActionButton.tsx
// Purpose: Shared icon button chrome for compact message actions.
// Layer: Web chat presentation component
// Exports: MessageActionButton

import { forwardRef, memo, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { IconButton } from "../ui/icon-button";
import type { TooltipPopup } from "../ui/tooltip";

export const MESSAGE_ACTION_BUTTON_CLASS_NAME =
  "sidebar-icon-button size-5 rounded-sm border-transparent bg-transparent shadow-none before:rounded-sm disabled:cursor-default disabled:opacity-45 sm:size-5";

type MessageActionButtonProps = Omit<
  ComponentProps<"button">,
  "aria-label" | "children" | "title"
> & {
  children: ReactNode;
  label: string;
  tooltip: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipPopup>["side"];
};

export const MessageActionButton = memo(
  forwardRef<HTMLButtonElement, MessageActionButtonProps>(function MessageActionButton(
    { children, className, label, tooltip, tooltipSide = "top", type = "button", ...props },
    ref,
  ) {
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
  }),
);
