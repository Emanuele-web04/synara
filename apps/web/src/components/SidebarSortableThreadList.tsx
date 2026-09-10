// FILE: SidebarSortableThreadList.tsx
// Purpose: Accessible drag-and-drop primitives for manually ordering sidebar conversations.
// Layer: Sidebar UI primitive
// Exports: sortable list/item wrappers and the dedicated conversation reorder handle.

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ThreadId } from "@synara/contracts";
import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { DragHandleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";

export type SidebarSortableThreadRenderProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef" | "setNodeRef"
> & {
  style: CSSProperties;
  sortableClassName: string;
};

type KeyboardReorderContextValue = {
  activeId: ThreadId | null;
  overId: ThreadId | null;
  handleKeyDown: (threadId: ThreadId, event: KeyboardEvent<HTMLButtonElement>) => boolean;
};

const KeyboardReorderContext = createContext<KeyboardReorderContextValue | null>(null);

export function SidebarSortableThreadList({
  items,
  onMove,
  onDragStart,
  onDragFinish,
  children,
}: {
  items: readonly { id: ThreadId; title: string }[];
  onMove: (input: {
    activeThreadId: ThreadId;
    overThreadId: ThreadId;
  }) => void;
  onDragStart?: (threadId: ThreadId) => void;
  onDragFinish?: () => void;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [keyboardPosition, setKeyboardPosition] = useState<{
    activeId: ThreadId;
    overId: ThreadId;
  } | null>(null);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState("");
  const titleById = new Map(items.map((item) => [item.id, item.title] as const));
  const positionOf = (id: ThreadId) => items.findIndex((item) => item.id === id) + 1;
  const describePosition = (id: ThreadId) =>
    `${titleById.get(id) ?? "Conversation"}, position ${positionOf(id)} of ${items.length}`;
  const toThreadId = (id: string | number): ThreadId => ThreadId.makeUnsafe(String(id));

  const handleDragStart = (event: DragStartEvent) => {
    setKeyboardPosition(null);
    onDragStart?.(toThreadId(event.active.id));
  };
  const handleDragCancel = (_event: DragCancelEvent) => {
    onDragFinish?.();
  };
  const handleDragEnd = (event: DragEndEvent) => {
    onDragFinish?.();
    if (!event.over || event.active.id === event.over.id) return;
    onMove({
      activeThreadId: toThreadId(event.active.id),
      overThreadId: toThreadId(event.over.id),
    });
  };
  const handleKeyboardReorder = (
    threadId: ThreadId,
    event: KeyboardEvent<HTMLButtonElement>,
  ): boolean => {
    const isToggleKey = event.key === " " || event.key === "Enter";
    if (!keyboardPosition) {
      if (!isToggleKey) return false;
      event.preventDefault();
      event.stopPropagation();
      setKeyboardPosition({ activeId: threadId, overId: threadId });
      setKeyboardAnnouncement(`${describePosition(threadId)} picked up.`);
      onDragStart?.(threadId);
      return true;
    }

    if (keyboardPosition.activeId !== threadId) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setKeyboardAnnouncement(
        `Moving ${titleById.get(keyboardPosition.activeId) ?? "conversation"} cancelled.`,
      );
      setKeyboardPosition(null);
      onDragFinish?.();
      return true;
    }
    if (isToggleKey) {
      event.preventDefault();
      event.stopPropagation();
      const { activeId, overId } = keyboardPosition;
      if (activeId !== overId) onMove({ activeThreadId: activeId, overThreadId: overId });
      setKeyboardAnnouncement(
        activeId === overId
          ? `${titleById.get(activeId) ?? "Conversation"} was not moved.`
          : `${titleById.get(activeId) ?? "Conversation"} moved to position ${positionOf(overId)} of ${items.length}.`,
      );
      setKeyboardPosition(null);
      onDragFinish?.();
      return true;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;

    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.findIndex((item) => item.id === keyboardPosition.overId);
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + direction));
    const nextOverId = items[nextIndex]?.id ?? keyboardPosition.overId;
    setKeyboardPosition({ ...keyboardPosition, overId: nextOverId });
    setKeyboardAnnouncement(`Moving to ${describePosition(nextOverId)}.`);
    return true;
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space to pick up a conversation, use the arrow keys to move it, then press Space to drop or Escape to cancel.",
        },
        announcements: {
          onDragStart: ({ active }) => `${describePosition(toThreadId(active.id))} picked up.`,
          onDragOver: ({ over }) =>
            over ? `Moving to ${describePosition(toThreadId(over.id))}.` : "Not over a position.",
          onDragEnd: ({ active, over }) =>
            over
              ? `${titleById.get(toThreadId(active.id)) ?? "Conversation"} moved to position ${positionOf(toThreadId(over.id))} of ${items.length}.`
              : "Conversation was not moved.",
          onDragCancel: ({ active }) =>
            `Moving ${titleById.get(toThreadId(active.id)) ?? "conversation"} cancelled.`,
        },
      }}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <KeyboardReorderContext.Provider
          value={{
            activeId: keyboardPosition?.activeId ?? null,
            overId: keyboardPosition?.overId ?? null,
            handleKeyDown: handleKeyboardReorder,
          }}
        >
          {children}
          <span className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
            {keyboardAnnouncement}
          </span>
        </KeyboardReorderContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

export function SidebarSortableThreadItem({
  threadId,
  children,
}: {
  threadId: ThreadId;
  children: (props: SidebarSortableThreadRenderProps) => ReactNode;
}) {
  const keyboardReorder = useContext(KeyboardReorderContext);
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: threadId });
  const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  return children({
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    style: {
      transform: CSS.Translate.toString(transform),
      transition: reduceMotion ? undefined : transition,
    },
    sortableClassName: cn(
      isDragging && "z-20 opacity-65",
      keyboardReorder?.activeId === threadId && "z-20 ring-1 ring-primary/40",
      (isOver || keyboardReorder?.overId === threadId) &&
        !isDragging &&
        "after:pointer-events-none after:absolute after:inset-x-2 after:-top-px after:z-30 after:h-px after:rounded-full after:bg-primary/75",
    ),
  });
}

export function SidebarThreadReorderHandle({
  threadId,
  title,
  manualOrder,
  sortable,
  onPointerIntent,
  onPointerRelease,
}: {
  threadId: ThreadId;
  title: string;
  manualOrder: boolean;
  sortable: Pick<
    SidebarSortableThreadRenderProps,
    "attributes" | "listeners" | "setActivatorNodeRef"
  >;
  onPointerIntent?: () => void;
  onPointerRelease?: () => void;
}) {
  const keyboardReorder = useContext(KeyboardReorderContext);
  const label = manualOrder ? `Reorder ${title}` : `Set a custom order starting with ${title}`;
  const pointerDownListener = sortable.listeners?.onPointerDown;
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onPointerIntent?.();
    pointerDownListener?.(event);
  };
  const handlePointerRelease = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onPointerRelease?.();
  };
  return (
    <button
      type="button"
      ref={sortable.setActivatorNodeRef}
      data-thread-reorder-handle={threadId}
      aria-label={label}
      title={manualOrder ? "Drag to reorder" : "Drag to set a custom order"}
      className="sidebar-icon-button pointer-events-auto relative z-10 inline-flex size-5 shrink-0 touch-none cursor-grab items-center justify-center rounded-sm text-muted-foreground/42 transition-colors hover:text-foreground/89 active:cursor-grabbing focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      {...sortable.attributes}
      {...sortable.listeners}
      aria-pressed={keyboardReorder?.activeId === threadId ? true : undefined}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerRelease}
      onPointerCancel={handlePointerRelease}
      onKeyDown={(event) => {
        if (keyboardReorder?.handleKeyDown(threadId, event)) return;
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <DragHandleIcon className={SIDEBAR_TRAILING_ICON_CLASS} />
    </button>
  );
}
