// FILE: SurfaceContentTabs.tsx
// Purpose: Browser-style content tabs shared by the open-thread strip in the chat header
//          and the right dock's pane strip. Tabs are comfortable while few are open, shrink
//          together as more open, and scroll behind an edge fade once they reach their
//          minimum width. Dragging a tab reorders it; holding it near an edge scrolls the
//          hidden tabs in.
// Layer: Chat surface UI primitive
// Depends on: the shared SurfaceTabStrip + SurfaceTabChip and dnd-kit's sortable preset.

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type ComponentProps,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";

import { DragHandleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { SurfaceTabChip, SurfaceTabStrip } from "./chatHeaderControls";

// Tab width in `em` of the chip's own UI font, so it scales with the font size chosen in
// Settings: every tab starts at a comfortable basis and shrinks evenly with the rest down
// to a floor that still fits the icon, a few characters, and the close button. Past the
// floor the strip scrolls instead of crushing the tabs further. The floor never exceeds
// the strip itself, so a strip squeezed by a narrow window still shows one whole tab.
// Width also supplies the strip's intrinsic size; the basis still drives tab shrinking.
const CONTENT_TAB_SIZE_CLASS_NAME = "w-[18em] min-w-[min(9em,100%)] grow-0 shrink basis-[18em]";
const CONTENT_TAB_FROZEN_SIZE_CLASS_NAME =
  "w-[var(--surface-tab-frozen-width)] min-w-0 grow-0 shrink-0 basis-[var(--surface-tab-frozen-width)]";
// The strip sits on the rail's shell band, above the card it belongs to (the chat, or the
// dock's panes). The active tab takes the card's own surface, so it reads as the open
// content rather than as a hovered tab (hover tints with ink; the shared chip's active fill
// is the same tint in light themes). On a whole-window glass shell the card is clear, and
// index.css swaps the fill for the raised glass tint (an ink tint in dark). Its hairline is
// inset: the tab fills its scroll strip edge to edge, and the strip's overflow and fade mask
// would crop an outer outline along the top, bottom, and first tab's left.
const CONTENT_TAB_ACTIVE_CLASS_NAME =
  "bg-[var(--app-rail-tab-active-surface,var(--color-background-surface))] hover:bg-[var(--app-rail-tab-active-surface,var(--color-background-surface))] shadow-[inset_0_0_0_0.5px_var(--app-rail-inset-border)]";

export interface SurfaceContentTab<Key extends string> {
  key: Key;
  /** The tab's label, also its tooltip and the name its close button announces. */
  title: string;
  icon: ReactNode;
  /** Omitted for a tab that cannot switch to anything: its label renders as static text. */
  onSelect?: (() => void) | undefined;
  /** Omitted for a tab that cannot close: no X, and a middle click does nothing. */
  onClose?: (() => void) | undefined;
  onTitleDoubleClick?: (() => void) | undefined;
  /** Opens the tab's context menu at the pointer. Omitted, the tab has none. */
  onContextMenu?: ((position: { x: number; y: number }) => void) | undefined;
}

function SortableSurfaceTabChip({
  sortableId,
  icon,
  labelClassName,
  ...chipProps
}: Omit<ComponentProps<typeof SurfaceTabChip>, "sortable"> & { sortableId: string }) {
  const sortable = useSortable({ id: sortableId });
  return (
    <SurfaceTabChip
      {...chipProps}
      // The hand opens over a tab and closes on it once pressed, through the whole drag.
      labelClassName={cn(
        labelClassName,
        sortable.isDragging ? "cursor-grabbing" : "cursor-grab active:cursor-grabbing",
      )}
      // Hovering swaps the tab's glyph for the reorder grip, in the same slot.
      icon={
        <>
          <span
            className={cn(
              "flex items-center justify-center transition-opacity group-hover/dock-tab:opacity-0",
              sortable.isDragging && "opacity-0",
            )}
          >
            {icon}
          </span>
          <DragHandleIcon
            aria-hidden
            className={cn(
              "absolute size-3.5 text-[var(--color-text-foreground-secondary)] opacity-0 transition-opacity group-hover/dock-tab:opacity-100",
              sortable.isDragging && "opacity-100",
            )}
          />
        </>
      }
      sortable={{
        setNodeRef: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // The dragged tab rides above the neighbours sliding out of its way.
          ...(sortable.isDragging ? { zIndex: 1 } : {}),
        },
        listeners: sortable.listeners && {
          ...sortable.listeners,
          // Ctrl+click is the context click on macOS: it opens the tab's menu, which
          // swallows the pointer release, so it must not arm a drag that never ends.
          onPointerDown: (event: PointerEvent) => {
            if (!event.ctrlKey) sortable.listeners?.onPointerDown?.(event);
          },
        },
      }}
    />
  );
}

export function SurfaceContentTabs<Key extends string>(props: {
  ariaLabel: string;
  tabs: readonly SurfaceContentTab<Key>[];
  activeKey: Key | null;
  selectionAria?: ComponentProps<typeof SurfaceTabChip>["selectionAria"];
  /** Drops the dragged tab onto another tab's slot. Omitted, the tabs are not draggable. */
  onMove?: ((key: Key, overKey: Key) => void) | undefined;
}) {
  const { tabs, activeKey, onMove } = props;
  // A press that travels becomes a drag; a still one stays a click on the tab or its X.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const navRef = useRef<HTMLElement>(null);
  // Closing tabs with the pointer keeps the survivors at their current width until the
  // pointer leaves the strip (like browser tabs), so the next X lands under the cursor
  // instead of the widened neighbour's title.
  const [frozenTabWidthPx, setFrozenTabWidthPx] = useState<number | null>(null);

  const freezeTabWidths = () => {
    const nav = navRef.current;
    // Every tab shares one width (same basis and floor), so any of them measures it.
    const tab = nav?.querySelector<HTMLElement>("[data-surface-tab]");
    if (nav?.matches(":hover") && tab) {
      setFrozenTabWidthPx(tab.getBoundingClientRect().width);
    }
  };

  const strip = (
    <SurfaceTabStrip
      activeKey={activeKey}
      dividers
      className="surface-content-tabs w-max max-w-full"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const { onClose } = tab;
        const chipProps = {
          active,
          closePlacement: "trailing",
          selectionAria: props.selectionAria,
          className: cn(
            frozenTabWidthPx === null
              ? CONTENT_TAB_SIZE_CLASS_NAME
              : CONTENT_TAB_FROZEN_SIZE_CLASS_NAME,
            active && CONTENT_TAB_ACTIVE_CLASS_NAME,
          ),
          title: tab.title,
          label: tab.title,
          icon: tab.icon,
          closeLabel: `Close ${tab.title}`,
          onSelect: tab.onSelect,
          onClose: onClose
            ? () => {
                freezeTabWidths();
                onClose();
              }
            : undefined,
          onLabelDoubleClick: tab.onTitleDoubleClick,
          onContextMenu: tab.onContextMenu,
        } satisfies ComponentProps<typeof SurfaceTabChip>;
        return onMove ? (
          <SortableSurfaceTabChip key={tab.key} sortableId={tab.key} {...chipProps} />
        ) : (
          <SurfaceTabChip key={tab.key} {...chipProps} />
        );
      })}
    </SurfaceTabStrip>
  );

  return (
    <nav
      ref={navRef}
      aria-label={props.ariaLabel}
      className="flex min-w-0 flex-1"
      style={
        frozenTabWidthPx === null
          ? undefined
          : ({ "--surface-tab-frozen-width": `${frozenTabWidthPx}px` } as CSSProperties)
      }
      onPointerLeave={() => setFrozenTabWidthPx(null)}
    >
      {onMove ? (
        // The strip is the drag's scroll container: dnd-kit scrolls it while a tab is held
        // near either edge, which brings tabs hidden past the neighbouring controls into reach.
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id) {
              onMove(active.id as Key, over.id as Key);
            }
          }}
        >
          <SortableContext
            items={tabs.map((tab) => tab.key)}
            strategy={horizontalListSortingStrategy}
          >
            {strip}
          </SortableContext>
        </DndContext>
      ) : (
        strip
      )}
    </nav>
  );
}
