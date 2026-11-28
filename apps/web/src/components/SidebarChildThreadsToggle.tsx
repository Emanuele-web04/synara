import type { CSSProperties } from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import { DisclosureChevron } from "./ui/DisclosureChevron";

export function SidebarChildThreadsToggle({
  count,
  collapsed,
  onToggle,
  className,
  style,
}: {
  count: number;
  collapsed: boolean;
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
      data-slot="child-threads-toggle"
      className={cn(
        "z-20 inline-flex size-[18px] cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/8 hover:text-foreground",
        "outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      style={style}
      // The toggle sits on (or beside) a row that opens its thread on press; folding must not.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <DisclosureChevron open={!collapsed} className="size-3" />
    </button>
  );
}
