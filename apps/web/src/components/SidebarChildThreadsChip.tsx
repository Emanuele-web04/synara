// FILE: SidebarChildThreadsChip.tsx
// Purpose: Count chip that folds and unfolds a parent's agent-created child threads. Sits in the
//          empty slot before a project row's glyph, over a pinned row's glyph, and at the start
//          of an Activity row's meta line, so one control works everywhere a parent appears.
// Layer: Sidebar UI component
// Exports: SidebarChildThreadsChip

import type { CSSProperties } from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import type { ChildThreadsTone } from "./SidebarActivityView.logic";
import { DisclosureChevron } from "./ui/DisclosureChevron";

// While folded, the tint names the most urgent child it hides; unfolded, the children show
// their own states, so the chip just reads as pressed.
const CHIP_TONE_CLASS_NAME: Record<ChildThreadsTone, string> = {
  waiting: "border-warning/35 bg-warning/14 text-warning",
  active: "border-info/30 bg-info/12 text-info",
  quiet: "border-foreground/12 text-muted-foreground hover:text-foreground",
};
const CHIP_OPEN_CLASS_NAME = "border-foreground/10 bg-foreground/10 text-foreground/80";

/** The slot before a glyph is about 22px wide, so larger counts collapse to "9+". */
function formatChildCount(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function SidebarChildThreadsChip({
  count,
  collapsed,
  tone,
  onToggle,
  className,
  style,
}: {
  count: number;
  collapsed: boolean;
  /** Most urgent state among the children; only drawn while folded. */
  tone: ChildThreadsTone;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const label = collapsed
    ? t("workspace:showChildThreads", { count })
    : t("workspace:hideChildThreads", { count });
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      data-slot="child-threads-chip"
      className={cn(
        "group/child-chip z-20 inline-flex h-[18px] min-w-[18px] cursor-pointer items-center justify-center rounded-md border px-1 text-ui-xs leading-none font-semibold tabular-nums transition-colors",
        "outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        collapsed ? CHIP_TONE_CLASS_NAME[tone] : CHIP_OPEN_CLASS_NAME,
        className,
      )}
      style={style}
      // The chip sits on (or beside) a row that opens its thread on press; folding must not.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="group-hover/child-chip:hidden group-focus-visible/child-chip:hidden">
        {formatChildCount(count)}
      </span>
      <DisclosureChevron
        open={!collapsed}
        className="hidden size-3 group-hover/child-chip:block group-focus-visible/child-chip:block"
      />
    </button>
  );
}
