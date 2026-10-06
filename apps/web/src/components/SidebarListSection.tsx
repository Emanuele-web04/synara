// FILE: SidebarListSection.tsx
// Purpose: The pieces a sidebar-style list is built from, shared by the sidebar's Activity view
//          and the code review list: a plain section label, a collapsible section (label +
//          inline disclosure chevron over the shared disclosure motion), and the "Show more" /
//          "Show less" paging row. Section-to-section spacing is owned by the parent list.
// Layer: Sidebar UI primitive
// Exports: SidebarSectionLabel, SidebarCollapsibleSection, SidebarShowMoreRow

import { Children, type MouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_FOCUS_CLASS_NAME, SIDEBAR_SECTION_LABEL_CLASS_NAME } from "~/sidebarRowStyles";
import type { SidebarRowContextMenuPosition } from "./sidebarThreadRowGestures";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";

/** A section's title where the section cannot fold (Pinned, date buckets, project blocks). */
export function SidebarSectionLabel({
  label,
  as: Tag = "div",
  className,
  onContextMenu,
}: {
  label: string;
  /** "h2" where the label heads a landmark section (the code review list). */
  as?: "div" | "h2";
  className?: string;
  /** Project blocks carry the same right-click menu as a classic project row. */
  onContextMenu?: (position: SidebarRowContextMenuPosition) => void;
}) {
  return (
    <Tag
      data-slot="activity-section-label"
      className={cn("m-0 mb-1.5 px-2 font-normal", className)}
      {...(onContextMenu
        ? {
            onContextMenu: (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu({ x: event.clientX, y: event.clientY });
            },
          }
        : {})}
    >
      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{label}</span>
    </Tag>
  );
}

/**
 * A section that folds behind its label (Pinned, Earlier, Done in Activity; the involvement
 * sections of the code review list). The rows stay mounted while folded so a reopen animates and
 * focus is not lost.
 */
export function SidebarCollapsibleSection({
  label,
  open,
  onToggle,
  children,
  revealedChildren,
  className,
  headerClassName,
  headingLevel,
  compactLabel,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Rows kept visible under the header while the section is collapsed (the open thread). */
  revealedChildren?: ReactNode;
  className?: string;
  /** Aligns the label with rows that pad differently from the sidebar's own. */
  headerClassName?: string;
  /** Wraps the toggle in a heading where the section is a landmark (the code review list). */
  headingLevel?: 2;
  /** Alternate icon/count for narrow conversation rails. */
  compactLabel?: ReactNode;
}) {
  const toggle = (
    <button
      type="button"
      className={cn(
        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5",
        SIDEBAR_ROW_FOCUS_CLASS_NAME,
        headerClassName,
      )}
      aria-expanded={open}
      aria-label={compactLabel ? label : undefined}
      data-slot="sidebar-section-toggle"
      data-compact-label={compactLabel ? "true" : undefined}
      onClick={onToggle}
    >
      <span className={cn("min-w-0 truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>{label}</span>
      <DisclosureChevron open={open} className="text-muted-foreground/58" />
      {compactLabel ? (
        <span
          data-slot="sidebar-section-compact-label"
          className="hidden items-center justify-center gap-1 text-ui-xs"
        >
          {compactLabel}
        </span>
      ) : null}
    </button>
  );
  return (
    <div className={className}>
      {headingLevel === 2 ? <h2 className="m-0 font-normal">{toggle}</h2> : toggle}
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
      </DisclosureRegion>
      {Children.count(revealedChildren) > 0 ? (
        <div className="flex flex-col gap-0.5 pt-0.5">{revealedChildren}</div>
      ) : null}
    </div>
  );
}

/** Pages a section's rows: "Show more" adds a page, "Show less" takes one back. */
export function SidebarShowMoreRow({
  canShowMore,
  canShowLess,
  onShowMore,
  onShowLess,
  className,
}: {
  canShowMore: boolean;
  canShowLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
  /** Padding of the buttons, where the rows above pad differently from the sidebar's own. */
  className?: string;
}) {
  if (!canShowMore && !canShowLess) return null;
  const buttonClassName = cn(
    "h-7 cursor-pointer rounded-lg px-2.5 text-left text-ui text-muted-foreground/79 hover:text-foreground",
    SIDEBAR_ROW_FOCUS_CLASS_NAME,
    className,
  );
  return (
    <div className="flex w-full items-center gap-1">
      {canShowMore ? (
        <button type="button" className={cn(buttonClassName, "flex-1")} onClick={onShowMore}>
          Show more
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          className={cn(buttonClassName, canShowMore ? "flex-none" : "flex-1")}
          onClick={onShowLess}
        >
          Show less
        </button>
      ) : null}
    </div>
  );
}
