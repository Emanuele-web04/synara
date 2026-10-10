// FILE: SidebarMetaChip.tsx
// Purpose: Tooltip-backed meta badges shown on thread rows (handoff, fork, temporary, etc.).
// Layer: Sidebar UI primitive
// Exports: SidebarMetaChip, SidebarMetaChipStack, SidebarMetaChipPlaceholder

import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Match the hover actions' 20px slots and 8px gap; glyphs match the provider avatar.
const CHIP_SLOT =
  "inline-flex size-5 shrink-0 items-center justify-center [&_svg]:size-3 [&_[data-slot=central-icon]]:size-3";

function SidebarMetaChip({ tooltip, children }: { tooltip: string; children: ReactNode }) {
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
  return (
    <div className="inline-flex shrink-0 items-center gap-2">
      {chips.map((chip) => (
        <SidebarMetaChip key={chip.id} tooltip={chip.tooltip}>
          {chip.icon}
        </SidebarMetaChip>
      ))}
    </div>
  );
}

/** Keeps trailing meta column width stable when a row has no badges. */
function SidebarMetaChipPlaceholder() {
  return <span className={CHIP_SLOT} />;
}
