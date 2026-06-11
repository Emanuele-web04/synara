"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as React from "react";

import { cn } from "~/lib/utils";

interface KanbanContextValue {
  activeId: string | null;
  disabled: boolean;
  itemIdsByColumn: Readonly<Record<string, readonly string[]>>;
}

const KanbanContext = React.createContext<KanbanContextValue | null>(null);
const KanbanItemContext = React.createContext<ReturnType<typeof useSortable> | null>(null);

function useKanbanContext(): KanbanContextValue {
  const context = React.useContext(KanbanContext);
  if (!context) {
    throw new Error("Kanban components must be rendered inside <Kanban>.");
  }
  return context;
}

function cloneColumns<T>(value: Record<string, T[]>): Record<string, T[]> {
  const next: Record<string, T[]> = {};
  for (const columnId of Object.keys(value)) {
    next[columnId] = [...(value[columnId] ?? [])];
  }
  return next;
}

function findItemColumn<T>(
  value: Record<string, T[]>,
  itemId: string,
  getItemValue: (item: T) => string,
): string | null {
  for (const columnId of Object.keys(value)) {
    if ((value[columnId] ?? []).some((item) => getItemValue(item) === itemId)) {
      return columnId;
    }
  }
  return null;
}

function buildItemIdsByColumn<T>(
  value: Record<string, T[]>,
  getItemValue: (item: T) => string,
): Record<string, string[]> {
  const itemIdsByColumn: Record<string, string[]> = {};
  for (const columnId of Object.keys(value)) {
    itemIdsByColumn[columnId] = (value[columnId] ?? []).map(getItemValue);
  }
  return itemIdsByColumn;
}

export interface KanbanProps<T> {
  value: Record<string, T[]>;
  onValueChange: (next: Record<string, T[]>) => void;
  getItemValue: (item: T) => string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

export function Kanban<T>(props: KanbanProps<T>) {
  const { value, onValueChange, getItemValue, children, className, disabled = false } = props;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const itemIdsByColumn = React.useMemo(
    () => buildItemIdsByColumn(value, getItemValue),
    [value, getItemValue],
  );

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      if (disabled || !event.over) {
        return;
      }

      const activeItemId = String(event.active.id);
      const overId = String(event.over.id);
      const sourceColumnId = findItemColumn(value, activeItemId, getItemValue);
      const targetColumnId =
        findItemColumn(value, overId, getItemValue) ??
        (Object.hasOwn(value, overId) ? overId : null);

      if (!sourceColumnId || !targetColumnId) {
        return;
      }

      const next = cloneColumns(value);
      const sourceItems = next[sourceColumnId] ?? [];
      const sourceIndex = sourceItems.findIndex((item) => getItemValue(item) === activeItemId);
      if (sourceIndex < 0) {
        return;
      }

      if (sourceColumnId === targetColumnId) {
        const targetIndex = sourceItems.findIndex((item) => getItemValue(item) === overId);
        if (targetIndex < 0 || sourceIndex === targetIndex) {
          return;
        }
        next[sourceColumnId] = arrayMove(sourceItems, sourceIndex, targetIndex);
        onValueChange(next);
        return;
      }

      const [movingItem] = sourceItems.splice(sourceIndex, 1);
      if (!movingItem) {
        return;
      }
      const targetItems = next[targetColumnId] ?? [];
      const overItemIndex = targetItems.findIndex((item) => getItemValue(item) === overId);
      const insertIndex = overItemIndex >= 0 ? overItemIndex : targetItems.length;
      targetItems.splice(insertIndex, 0, movingItem);
      next[sourceColumnId] = sourceItems;
      next[targetColumnId] = targetItems;
      onValueChange(next);
    },
    [disabled, getItemValue, onValueChange, value],
  );

  const context = React.useMemo<KanbanContextValue>(
    () => ({
      activeId,
      disabled,
      itemIdsByColumn,
    }),
    [activeId, disabled, itemIdsByColumn],
  );

  return (
    <KanbanContext.Provider value={context}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className={className}>{children}</div>
      </DndContext>
    </KanbanContext.Provider>
  );
}

export function KanbanBoard({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex min-w-0 gap-3", className)} {...props} />;
}

export interface KanbanColumnProps extends React.ComponentPropsWithoutRef<"section"> {
  value: string;
}

export function KanbanColumn({ value, className, ...props }: KanbanColumnProps) {
  const { disabled } = useKanbanContext();
  const { setNodeRef, isOver } = useDroppable({ id: value, disabled });
  return (
    <section
      ref={setNodeRef}
      data-over={isOver ? "" : undefined}
      className={className}
      {...props}
    />
  );
}

export interface KanbanColumnContentProps extends React.ComponentPropsWithoutRef<"ul"> {
  value: string;
}

export function KanbanColumnContent({ value, className, ...props }: KanbanColumnContentProps) {
  const { itemIdsByColumn } = useKanbanContext();
  return (
    <SortableContext
      items={[...(itemIdsByColumn[value] ?? [])]}
      strategy={verticalListSortingStrategy}
    >
      <ul className={className} {...props} />
    </SortableContext>
  );
}

export interface KanbanItemProps extends React.ComponentPropsWithoutRef<"li"> {
  value: string;
}

export function KanbanItem({ value, className, style, ...props }: KanbanItemProps) {
  const { disabled } = useKanbanContext();
  const sortable = useSortable({ id: value, disabled });
  const transform = CSS.Translate.toString(sortable.transform);
  const itemStyle: React.CSSProperties = {
    ...style,
    transform,
    transition: sortable.transition,
  };

  return (
    <KanbanItemContext.Provider value={sortable}>
      <li
        ref={sortable.setNodeRef}
        className={cn(sortable.isDragging && "opacity-45", className)}
        style={itemStyle}
        {...props}
      />
    </KanbanItemContext.Provider>
  );
}

export function KanbanItemHandle({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const sortable = React.useContext(KanbanItemContext);
  return (
    <div
      className={cn("cursor-grab active:cursor-grabbing", className)}
      {...props}
      {...sortable?.attributes}
      {...sortable?.listeners}
    >
      {children}
    </div>
  );
}

export function KanbanColumnHandle({
  render,
}: {
  render: (props: React.ComponentPropsWithoutRef<"button">) => React.ReactNode;
}) {
  return render({
    type: "button",
    "aria-label": "Drag column",
  });
}

export function KanbanOverlay({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { activeId } = useKanbanContext();
  return (
    <DragOverlay dropAnimation={{ duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
      {activeId ? <div className={className}>{children}</div> : null}
    </DragOverlay>
  );
}
