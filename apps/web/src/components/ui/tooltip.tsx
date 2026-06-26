import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "~/lib/utils";
import {
  APP_TOOLTIP_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

/**
 * Tooltip surface variants. Every tooltip in the app is the same `TooltipPopup`;
 * the variant only swaps its chrome, so different tooltips can wear different
 * looks without forking the component. Add a new style here (and a key) to make it
 * available everywhere.
 *
 * - `default`: the frosted sidebar hover-card surface, shared with the
 *   project/thread cards so plain tooltips and the cards read as one system.
 * - `picker`: the composer picker chrome (tighter radius + soft shadow) for
 *   tooltips that sit next to picker menus and should match them.
 */
export type TooltipVariant = "default" | "picker";

const TOOLTIP_SURFACE_BY_VARIANT: Record<TooltipVariant, string> = {
  default: APP_TOOLTIP_SURFACE_CLASS_NAME,
  picker: COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME,
};

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipPopup({
  className,
  positionerClassName,
  viewportClassName,
  variant = "default",
  align = "center",
  sideOffset = 4,
  side = "top",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  // Surface chrome preset; see TOOLTIP_SURFACE_BY_VARIANT. `className` still wins
  // for per-tooltip tweaks (max-width, wrapping) on top of the chosen variant.
  variant?: TooltipVariant;
  // Stacking lives on the positioner (the portaled, positioned element), so a
  // z-index override has to land here rather than on the popup className.
  positionerClassName?: string;
  // The viewport owns the inner inset (px-2 py-1) for plain text tooltips; rich
  // cards that bring their own padding can zero it here so they don't double up.
  viewportClassName?: string;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className={cn(
          "z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          positionerClassName,
        )}
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            // Structure + type are shared by every tooltip; the variant supplies the
            // surface chrome (frosted card, picker, …) and `className` adds per-tooltip
            // tweaks like max-width or wrapping.
            "flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance text-[length:var(--app-font-size-ui-sm,11px)] transition-[width,height,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
            TOOLTIP_SURFACE_BY_VARIANT[variant],
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className={cn(
              "relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              viewportClassName,
            )}
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipCreateHandle, TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup };
