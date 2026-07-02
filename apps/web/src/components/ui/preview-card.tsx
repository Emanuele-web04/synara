import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "~/lib/utils";

// Hover-triggered, interactive card (Base UI PreviewCard). Unlike a Tooltip it
// stays open while the pointer moves into the popup, so its content can hold
// clickable controls (used by the sidebar project/folder hover card).
const PreviewCard = PreviewCardPrimitive.Root;

function PreviewCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

function PreviewCardPopup({
  className,
  positionerClassName,
  align = "start",
  side = "right",
  sideOffset = 8,
  anchor,
  children,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  anchor?: PreviewCardPrimitive.Positioner.Props["anchor"];
  // Stacking lives on the positioner (the portaled, positioned element), so a
  // z-index override has to land here rather than on the popup className.
  positionerClassName?: string;
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        anchor={anchor}
        className={cn(
          "z-50 max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          positionerClassName,
        )}
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "origin-(--transform-origin) overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] shadow-lg transition-[transform,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="preview-card-popup"
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardTrigger, PreviewCardPopup };
