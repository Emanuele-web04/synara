// FILE: TreeRow.tsx
// Purpose: Full-bleed tree/list row with fixed lanes (disclosure, icon, label, actions), the
//          app's file-row tones for hover, selection and keyboard focus, the hover wash for
//          rows inside a selected subtree, and drop indicators for drag-to-reorder. Rows are
//          28px tall, the chevron in the indent, a 16px icon lane and the label 40px in at the
//          top level (the canvas layers and pages lists).
// Layer: UI primitive
// Exports: TreeRow, TreeRowRenameInput, TreeSectionHeader, treeRowIndent,
//          setTreeRowDragImage, TREE_ROW_REVEAL_CLASS_NAME

import { useRef, type ComponentProps, type DragEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { FILE_ROW_FOCUS_BLOCK_CLASS_NAME, fileRowToneClassName } from "../chat/fileRowStyles";
import { DisclosureChevron } from "./DisclosureChevron";
import { Input } from "./input";

const TREE_ROW_BASE_INDENT_PX = 2;
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

// Rows inside a selected subtree take the hover tone.
const TREE_ROW_TINT_CLASS_NAME = "bg-[var(--color-background-button-secondary-hover)]";

/** `deep` (an Alt-click on the chevron) opens or closes the whole subtree. */
type TreeRowDisclosure = { open: boolean; onToggle: (deep?: boolean) => void };

export function TreeRow({
  indent,
  selected = false,
  tinted = false,
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
  /** Trailing 48px lane (two icon-xs buttons); omit for rows without one, `null` keeps it empty. */
  actions?: ReactNode;
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
        "group/tree-row relative flex h-7 shrink-0 cursor-default select-none items-center pe-3 text-ui-sm outline-none transition-colors",
        fileRowToneClassName(selected),
        !selected && tinted && TREE_ROW_TINT_CLASS_NAME,
        FILE_ROW_FOCUS_BLOCK_CLASS_NAME,
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
          className={cn("ms-1.5 min-w-0 flex-1 truncate", muted && "opacity-40", labelClassName)}
        >
          {label}
        </span>
      )}
      {/* The rename field takes the actions lane too. */}
      {actions === undefined || editor ? null : (
        <span
          className="ms-1.5 flex h-6 w-12 shrink-0 items-center justify-end"
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
 * Title row above a group of tree rows ("Pages"), 32px like the panel headers, with an
 * optional trailing action. With `disclosure` the title opens and closes the group, its
 * chevron in the rows' disclosure lane.
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
  const heading = <h2 className="truncate text-ui-sm font-medium text-foreground">{title}</h2>;
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center justify-between gap-2 pe-3",
        disclosure ? "ps-0.5" : "ps-3",
        className,
      )}
    >
      {disclosure ? (
        <button
          type="button"
          aria-expanded={disclosure.open}
          className="flex h-full min-w-0 flex-1 items-center text-start outline-none focus-visible:underline"
          onClick={() => disclosure.onToggle()}
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <DisclosureChevron open={disclosure.open} className="size-3 text-muted-foreground" />
          </span>
          <span className="ms-0.5 min-w-0">{heading}</span>
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
