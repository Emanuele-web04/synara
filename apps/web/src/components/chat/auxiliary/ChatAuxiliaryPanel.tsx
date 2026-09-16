import type { ReactNode } from "react";

import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import {
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";

export const AUXILIARY_PANEL_SURFACE_CLASS_NAME = `relative overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground ${COMPOSER_SURFACE_SHADOW_CLASS_NAME}`;

export const AUXILIARY_PANEL_MOTION_CLASS =
  "transition-[transform,opacity] duration-220 ease-out motion-reduce:transition-none";

export const AUXILIARY_CONTENT_INSET_MOTION_CLASS =
  "transition-[padding-right] duration-220 ease-out motion-reduce:transition-none";

const OVERLAY_WRAPPER_CLASS_NAME =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3";

export interface ChatAuxiliaryPanelProps {
  open: boolean;
  variant: "docked" | "floating";
  mobile: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}

export function ChatAuxiliaryPanel({
  open,
  variant,
  mobile,
  title,
  description,
  children,
  onClose,
}: ChatAuxiliaryPanelProps) {
  if (mobile) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetPopup side="bottom" className="max-h-[85vh]">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">{children}</div>
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <div
      className={OVERLAY_WRAPPER_CLASS_NAME}
      data-auxiliary-panel-variant={variant}
      data-disclosure-ms={DISCLOSURE_TRANSITION_MS}
      aria-hidden={!open}
    >
      <div
        className={cn(
          AUXILIARY_PANEL_SURFACE_CLASS_NAME,
          AUXILIARY_PANEL_MOTION_CLASS,
          "flex max-h-full w-72 flex-col",
          open
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
