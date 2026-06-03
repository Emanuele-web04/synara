// FILE: SidebarMetaChip.tsx
// Purpose: Tooltip-backed meta badges shown on thread rows (handoff, fork, disposable, etc.).
// Layer: Sidebar UI primitive
// Exports: SidebarMetaChip, SidebarMetaChipStack, SidebarMetaChipPlaceholder

import type { MouseEvent, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const CHIP_SLOT = "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center";

type SidebarMetaChipInput = {
  tooltip: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export function SidebarMetaChip({ tooltip, children, onClick }: SidebarMetaChipInput) {
  const trigger = onClick ? (
    <button
      type="button"
      className={CHIP_SLOT}
      aria-label={tooltip}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      }}
    >
      {children}
    </button>
  ) : (
    <span className={CHIP_SLOT}>{children}</span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarMetaChipStack({
  chips,
}: {
  chips: Array<{
    id: string;
    tooltip: string;
    icon: ReactNode;
    onClick?: (event: MouseEvent<HTMLElement>) => void;
  }>;
}) {
  if (chips.length === 0) {
    return <SidebarMetaChipPlaceholder />;
  }
  if (chips.length === 1) {
    const only = chips[0]!;
    return (
      <SidebarMetaChip tooltip={only.tooltip} onClick={only.onClick}>
        {only.icon}
      </SidebarMetaChip>
    );
  }

  const tooltipText = chips.map((chip) => chip.tooltip).join(" · ");
  const chipSize = 14;
  const step = 8;
  const width = chipSize + step * (chips.length - 1);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="relative h-3.5 shrink-0"
            style={{ width: `${width}px` }}
            aria-label={tooltipText}
          >
            {chips.map((chip, index) => {
              const className =
                "absolute top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background shadow-xs";
              const style = { left: `${index * step}px`, zIndex: index + 1 };
              return chip.onClick ? (
                <button
                  key={chip.id}
                  type="button"
                  className={className}
                  style={style}
                  aria-label={chip.tooltip}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    chip.onClick?.(event);
                  }}
                >
                  {chip.icon}
                </button>
              ) : (
                <span key={chip.id} className={className} style={style}>
                  {chip.icon}
                </span>
              );
            })}
          </div>
        }
      />
      <TooltipPopup side="top">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
}

/** Keeps trailing meta column width stable when a row has no badges. */
export function SidebarMetaChipPlaceholder() {
  return <span className={CHIP_SLOT} />;
}
