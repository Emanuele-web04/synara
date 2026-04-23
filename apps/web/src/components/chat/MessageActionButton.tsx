// FILE: MessageActionButton.tsx
// Purpose: Shared icon button chrome for compact message actions.
// Layer: Web chat presentation component
// Exports: MessageActionButton

import { forwardRef, memo, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MESSAGE_ACTION_BUTTON_CLASS_NAME =
  "sidebar-icon-button inline-flex size-5 cursor-pointer border border-transparent bg-transparent shadow-none disabled:cursor-default disabled:opacity-45";

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
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              {...props}
              ref={ref}
              type={type}
              aria-label={label}
              className={cn(MESSAGE_ACTION_BUTTON_CLASS_NAME, className)}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side={tooltipSide}>
          {typeof tooltip === "string" ? <p>{tooltip}</p> : tooltip}
        </TooltipPopup>
      </Tooltip>
    );
  }),
);
