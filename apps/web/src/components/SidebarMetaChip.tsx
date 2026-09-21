import type { ReactNode } from "react";
import { SIDEBAR_TRAILING_ICON_FORCE_CLASS } from "./sidebarGlyphs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// icons forced to the shared trailing size so the whole right-side cluster reads as one set; CHIP_SLOT_PX drives the overlap math (Tailwind scans literal class strings only, keep in step with h-[15px]/w-[15px])
const CHIP_SLOT_PX = 15;
const CHIP_SLOT = `inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center ${SIDEBAR_TRAILING_ICON_FORCE_CLASS}`;

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
  if (chips.length === 1) {
    const only = chips[0]!;
    return <SidebarMetaChip tooltip={only.tooltip}>{only.icon}</SidebarMetaChip>;
  }

  const tooltipText = chips.map((chip) => chip.tooltip).join(" · ");
  const chipSize = CHIP_SLOT_PX;
  const step = 8;
  const width = chipSize + step * (chips.length - 1);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="relative h-[15px] shrink-0"
            style={{ width: `${width}px` }}
            aria-label={tooltipText}
          >
            {chips.map((chip, index) => (
              <span
                key={chip.id}
                className={`sidebar-icon-chip absolute top-1/2 inline-flex size-[15px] -translate-y-1/2 items-center justify-center rounded-full ${SIDEBAR_TRAILING_ICON_FORCE_CLASS}`}
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
function SidebarMetaChipPlaceholder() {
  return <span className={CHIP_SLOT} />;
}
