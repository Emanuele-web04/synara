// FILE: SidebarCustomizeList.tsx
// Purpose: The "Customize" editor for sidebar navigation: a header with Done, and sortable
//          rows with a visibility checkbox, label, and drag handle.
// Layer: Sidebar UI primitive (the classic nav card and the rail layout's customize popover)
// Exports: SidebarCustomizeHeader, SidebarCustomizeList, SidebarCustomizeItem

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComponentType } from "react";

import { DragHandleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "~/sidebarRowStyles";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export type SidebarCustomizeItem = {
  readonly id: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly iconClassName?: string | undefined;
  readonly label: string;
  readonly visible: boolean;
  /** Always shown: the checkbox stays checked and disabled (the item can still move). */
  readonly locked?: boolean | undefined;
};

export function SidebarCustomizeHeader({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex items-center justify-between ps-2 pe-1 pt-0.5 pb-1">
      <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Customize</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-ui text-primary hover:text-primary"
        onClick={onDone}
      >
        Done
      </Button>
    </div>
  );
}

/** One row: visibility checkbox + label + drag handle. */
function SidebarCustomizeRow({
  item,
  onVisibleChange,
}: {
  item: SidebarCustomizeItem;
  onVisibleChange: (visible: boolean) => void;
}) {
  const { icon: Icon, iconClassName, label, visible, locked } = item;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative list-none", isDragging && "z-20 opacity-80")}
    >
      <div
        className={cn(
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
          "cursor-default",
        )}
      >
        <Checkbox
          checked={visible}
          disabled={locked}
          onCheckedChange={(checked) => onVisibleChange(Boolean(checked))}
          aria-label={
            locked
              ? `${label} is always shown`
              : visible
                ? `Hide ${label} from the sidebar`
                : `Show ${label} in the sidebar`
          }
        />
        <SidebarLeadingIcon size="sm" tone="text-inherit">
          <SidebarGlyph
            icon={Icon}
            variant="leading"
            {...(iconClassName ? { className: iconClassName } : {})}
          />
        </SidebarLeadingIcon>
        <span className="truncate">{label}</span>
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="ml-auto inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
          aria-label={`Reorder ${label}`}
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

/** Sortable rows; `onReorder` receives the dragged id and the id it was dropped on. */
export function SidebarCustomizeList({
  items,
  onReorder,
  onVisibleChange,
}: {
  items: ReadonlyArray<SidebarCustomizeItem>;
  onReorder: (activeId: string, overId: string) => void;
  onVisibleChange: (id: string, visible: boolean) => void;
}) {
  // Same activation distance as the project list, so a click on the checkbox never drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex w-full min-w-0 flex-col gap-0.5">
          {items.map((item) => (
            <SidebarCustomizeRow
              key={item.id}
              item={item}
              onVisibleChange={(visible) => onVisibleChange(item.id, visible)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
