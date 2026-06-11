// FILE: SidebarMetaChip.tsx
// Purpose: Tooltip-backed meta badges shown on thread rows (handoff, fork, disposable, etc.).
// Layer: Sidebar UI primitive
// Exports: SidebarMetaChip, SidebarMetaChipStack, SidebarMetaChipPlaceholder

import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const CHIP_SLOT = "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center";

export function SidebarMetaChip({ tooltip, children }: { tooltip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={CHIP_SLOT}>{children}</span>} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarMetaChipStack({
  chips,
}: {
  chips: Array<{ id: string; tooltip: string; icon: ReactNode }>;
}) {
  if (chips.length === 0) {
    return <SidebarMetaChipPlaceholder />;
  }
  if (chips.length === 1) {
    const only = chips[0]!;
    return <SidebarMetaChip tooltip={only.tooltip}>{only.icon}</SidebarMetaChip>;
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
            {chips.map((chip, index) => (
              <span
                key={chip.id}
                className="sidebar-icon-chip absolute top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full"
                style={{ left: `${index * step}px`, zIndex: index + 1 }}
              >
                {chip.icon}
              </span>
            ))}
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
