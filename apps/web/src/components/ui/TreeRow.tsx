// FILE: TreeRow.tsx
// Purpose: Tree/list row with fixed lanes (disclosure, icon, label, actions) in the main
//          sidebar's row style: inset from the panel edges, rounded, the sidebar's hover,
//          selected and keyboard-focus treatment; a hover wash for rows inside a selected
//          subtree, and drop indicators for drag-to-reorder. Rows are 28px tall, the chevron in
//          the indent, a 16px icon lane, and the lanes stay put at every depth (the canvas layers
//          and pages lists).
// Layer: UI primitive
// Exports: TreeRow, TreeRowRenameInput, TreeSectionHeader, treeRowIndent,
//          setTreeRowDragImage, TREE_ROW_REVEAL_CLASS_NAME, TREE_SECTION_LABEL_CLASS_NAME

import { useRef, type ComponentProps, type DragEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
} from "~/sidebarRowStyles";
import { DisclosureChevron } from "./DisclosureChevron";
import { Input } from "./input";

const TREE_ROW_BASE_INDENT_PX = 4;
const TREE_ROW_DEPTH_INDENT_PX = 14;
/** The disclosure lane (16px): where the icon lane starts. */
const TREE_ROW_DISCLOSURE_LANE_PX = 16;

/**
 * Inline-start padding for a row at `depth`, so children sit under their parent's icon. `step`
 * overrides the per-level indent (the canvas layers panel uses 16 px).
 */
export function treeRowIndent(depth: number, step = TREE_ROW_DEPTH_INDENT_PX): number {
  return TREE_ROW_BASE_INDENT_PX + depth * step;
}

/** Row actions that only show while the row is hovered or focused (an eye, a lock). */
export const TREE_ROW_REVEAL_CLASS_NAME =
  "opacity-0 group-hover/tree-row:opacity-100 group-focus-visible/tree-row:opacity-100 focus-visible:opacity-100";

/** A section's title over tree rows ("Pages", "Layers"): the sidebar's muted label tone. */
export const TREE_SECTION_LABEL_CLASS_NAME = cn(
  "text-ui-sm font-normal",
  SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
);

// Rows inside a selected subtree take the hover tone.
const TREE_ROW_TINT_CLASS_NAME = "bg-[var(--color-background-button-secondary-hover)]";

/** `deep` (an Alt-click on the chevron) opens or closes the whole subtree. */
type TreeRowDisclosure = { open: boolean; onToggle: (deep?: boolean) => void };

/**
 * Where a row sits in a run of filled rows (a selected row and the tinted rows under it): the
 * run reads as one rounded block, so the corners between its rows are square.
 */
export type TreeRowRun = "start" | "middle" | "end";

const RUN_CORNER_CLASS_NAMES: Record<TreeRowRun, string> = {
  start: "rounded-b-none",
  middle: "rounded-none",
  end: "rounded-t-none",
};

export function TreeRow({
  indent,
  selected = false,
  tinted = false,
  run,
  actionsPinned = false,
  muted = false,
  disclosure,
  icon,
  iconClassName,
  label,
  labelClassName,
  editor,
  actions,
  drop = null,
  dropIndent,
  onIconDoubleClick,
  className,
  style,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  /** Inline-start padding in px; derive it from depth with {@link treeRowIndent}. */
  indent: number;
  selected?: boolean | undefined;
  /** Inside a selected subtree. */
  tinted?: boolean | undefined;
  /** The row's place in a run of filled rows, which square the corners between them. */
  run?: TreeRowRun | undefined;
  /** Hidden content: the label fades to 40% and the leading glyphs to half strength. */
  muted?: boolean | undefined;
  /** Omit for rows without a disclosure lane; `null` keeps the lane empty so icons align. */
  disclosure?: TreeRowDisclosure | null | undefined;
  icon?: ReactNode;
  /** Size and color of the icon lane (a 16px lane, muted; selected rows use the text color). */
  iconClassName?: string | undefined;
  label: ReactNode;
  labelClassName?: string | undefined;
  /** Replaces the label while the row is being renamed. */
  editor?: ReactNode;
  /**
   * Trailing 48px lane (two icon-xs buttons) at the row's end, the same lane at every depth. The
   * label runs under it while its buttons are hidden and makes room on hover or focus.
   */
  actions?: ReactNode;
  /** An action is on and always shown (a lock, a hidden eye): the label keeps the lane clear. */
  actionsPinned?: boolean | undefined;
  drop?: "before" | "after" | "inside" | null | undefined;
  /** Where a before/after drop line starts, when the drop lands at another depth than the row. */
  dropIndent?: number | undefined;
  /** A double-click on the icon lane only (the canvas centres the camera on the layer). */
  onIconDoubleClick?: (() => void) | undefined;
}) {
  const glyphTone = selected ? "text-foreground" : "text-muted-foreground";
  return (
    <div
      {...props}
      className={cn(
        "group/tree-row relative mx-2 flex h-7 shrink-0 cursor-default select-none items-center pe-1 text-ui-sm",
        SIDEBAR_ROW_RADIUS_CLASS_NAME,
        SIDEBAR_ROW_FOCUS_CLASS_NAME,
        selected
          ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
          : tinted
            ? cn("text-foreground", TREE_ROW_TINT_CLASS_NAME)
            : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
        run && RUN_CORNER_CLASS_NAMES[run],
        drop === "inside" && "ring-1 ring-inset ring-ring",
        className,
      )}
      style={{ ...style, paddingInlineStart: indent }}
    >
      {drop === "before" || drop === "after" ? (
        <span
          aria-hidden
          data-tree-row-drop={drop}
          className={cn(
            "pointer-events-none absolute end-0 z-10 h-0.5 bg-foreground",
            drop === "before" ? "-top-px" : "-bottom-px",
          )}
          style={{
            insetInlineStart:
              (dropIndent ?? indent) + (disclosure === undefined ? 0 : TREE_ROW_DISCLOSURE_LANE_PX),
          }}
        />
      ) : null}
      {disclosure === undefined ? null : (
        <span
          className={cn(
            "flex h-full w-4 shrink-0 items-center justify-center",
            muted && "opacity-50",
          )}
        >
          {disclosure ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="flex size-4 items-center justify-center"
              onClick={(event) => {
                event.stopPropagation();
                disclosure.onToggle(event.altKey);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <DisclosureChevron
                open={disclosure.open}
                className={cn("size-3", selected ? "text-foreground" : "text-muted-foreground")}
              />
            </button>
          ) : null}
        </span>
      )}
      <span
        data-tree-row-icon=""
        onDoubleClick={
          onIconDoubleClick
            ? (event) => {
                event.stopPropagation();
                onIconDoubleClick();
              }
            : undefined
        }
        className={cn(
          "flex size-4 shrink-0 items-center justify-center",
          glyphTone,
          iconClassName,
          muted && "opacity-50",
        )}
      >
        {icon}
      </span>
      {editor ?? (
        <span
          data-tree-row-label=""
          className={cn(
            "ms-1.5 min-w-0 flex-1 truncate",
            // The actions lane sits over the label's end: the label gives it room while the
            // actions show (hover, focus), and keeps it while one is pinned on.
            actions
              ? actionsPinned
                ? "me-[3.25rem]"
                : "group-focus-within/tree-row:me-[3.25rem] group-hover/tree-row:me-[3.25rem]"
              : null,
            muted && "opacity-40",
            labelClassName,
          )}
        >
          {label}
        </span>
      )}
      {/* The rename field takes the actions lane too. */}
      {actions === undefined || actions === null || editor ? null : (
        <span
          className="absolute inset-y-0 end-1 flex w-12 items-center justify-end"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </div>
  );
}

/**
 * Inline rename field for a {@link TreeRow}: the text stays where the label was, Enter or
 * leaving the field saves, Escape cancels. With `onTab`, Tab and Shift+Tab save and hand the
 * rename on to the next or previous row.
 */
export function TreeRowRenameInput({
  defaultValue,
  label,
  maxLength,
  onCommit,
  onCancel,
  onTab,
}: {
  defaultValue: string;
  label: string;
  maxLength?: number | undefined;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onTab?: ((backward: boolean) => void) | undefined;
}) {
  // Set once the field has saved or cancelled, so the blur that follows does nothing.
  const cancelled = useRef(false);
  return (
    <Input
      nativeInput
      size="xs"
      autoFocus
      defaultValue={defaultValue}
      aria-label={label}
      maxLength={maxLength}
      className="ms-0.5 min-w-0 flex-1"
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Tab" && onTab) {
          event.preventDefault();
          cancelled.current = true;
          onCommit(event.currentTarget.value);
          onTab(event.shiftKey);
        } else if (event.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (cancelled.current) return;
        onCommit(event.currentTarget.value);
      }}
    />
  );
}

/**
 * Title row above a group of tree rows ("Pages", "Layers"), 32px, in the sidebar's muted label
 * style and lined up with the rows' first lane, with an optional trailing action. With
 * `disclosure` the title opens and closes the group, its chevron after the title like the
 * sidebar's folding sections.
 */
export function TreeSectionHeader({
  title,
  className,
  disclosure,
  children,
}: {
  title: string;
  className?: string | undefined;
  disclosure?: TreeRowDisclosure | undefined;
  children?: ReactNode;
}) {
  const heading = <h2 className={cn("truncate", TREE_SECTION_LABEL_CLASS_NAME)}>{title}</h2>;
  return (
    <div
      className={cn("flex h-8 shrink-0 items-center justify-between gap-2 ps-3 pe-3", className)}
    >
      {disclosure ? (
        <button
          type="button"
          aria-expanded={disclosure.open}
          className={cn(
            "-ms-1 flex h-6 min-w-0 items-center gap-1 rounded-md px-1 text-start",
            SIDEBAR_ROW_FOCUS_CLASS_NAME,
          )}
          onClick={() => disclosure.onToggle()}
        >
          {heading}
          <DisclosureChevron
            open={disclosure.open}
            className={cn("size-3", SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME)}
          />
        </button>
      ) : (
        heading
      )}
      {children}
    </div>
  );
}

/**
 * Drag image for a {@link TreeRow}: a small card with the row's icon and label instead of the
 * browser's translucent snapshot of the whole row.
 */
export function setTreeRowDragImage(event: DragEvent<HTMLElement>) {
  const row = event.currentTarget;
  const ghost = document.createElement("div");
  ghost.className =
    "pointer-events-none fixed -top-96 left-0 flex h-6 items-center gap-1.5 rounded-md border border-border bg-popover ps-1.5 pe-2 text-ui-sm text-popover-foreground shadow-md";
  const icon = row.querySelector("[data-tree-row-icon]")?.cloneNode(true);
  if (icon instanceof HTMLElement) {
    icon.style.color = "var(--muted-foreground)";
    ghost.append(icon);
  }
  const label = document.createElement("span");
  label.className = "whitespace-pre";
  label.textContent = row.querySelector("[data-tree-row-label]")?.textContent ?? "";
  ghost.append(label);
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 10, 11);
  // The browser snapshots the image when the handler returns.
  setTimeout(() => ghost.remove(), 0);
}
