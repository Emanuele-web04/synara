// FILE: OpenThreadTabStrip.tsx
// Purpose: Browser-style tabs for the open threads, shown in the chat header in place of
//          the thread title. Tabs are comfortable while few are open, shrink together as
//          more open, and scroll behind an edge fade once they reach their minimum width.
//          Dragging a tab reorders it; holding it near an edge scrolls the hidden tabs in.
// Layer: Chat header UI
// Depends on: open-thread tab hooks/store and the shared SurfaceTabStrip + SurfaceTabChip.

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectId, ThreadId } from "@synara/contracts";
import { type ComponentProps, type CSSProperties, useRef, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  useActivateThreadTab,
  useOpenThreadTabs,
  useReadRouteThreadId,
  useRecordOpenThreadTab,
} from "~/hooks/useOpenThreadTabs";
import { useOptimisticTabSelection } from "~/hooks/useOptimisticTabSelection";
import { DragHandleIcon, TerminalIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { createOpenThreadTabCloseQueue, replaceLastTabWithFreshChat } from "~/openThreadTabs.logic";
import { useOpenThreadTabsStore } from "~/openThreadTabsStore";

import { ProviderIcon } from "../ProviderIcon";
import { toastManager } from "../ui/toast";
import { SurfaceTabChip, SurfaceTabStrip } from "./chatHeaderControls";

// Tab width in `em` of the chip's own UI font, so it scales with the font size chosen in
// Settings: every tab starts at a comfortable basis and shrinks evenly with the rest down
// to a floor that still fits the icon, a few characters, and the close button. Past the
// floor the strip scrolls instead of crushing the tabs further. The floor never exceeds
// the strip itself, so a strip squeezed by a narrow window still shows one whole tab.
const OPEN_THREAD_TAB_SIZE_CLASS_NAME = "min-w-[min(9em,100%)] grow-0 shrink basis-[18em]";
const OPEN_THREAD_TAB_FROZEN_SIZE_CLASS_NAME =
  "min-w-0 grow-0 shrink-0 basis-[var(--open-thread-tab-frozen-width)]";
// The strip sits on the rail's shell band, above the chat card. The active tab takes the
// card's own surface, so it reads as the open thread rather than as a hovered tab (hover
// tints with ink; the shared chip's active fill is the same tint in light themes). Its
// hairline is inset: the tab fills its scroll strip edge to edge, and the strip's overflow
// and fade mask would crop an outer outline along the top, bottom, and first tab's left.
const OPEN_THREAD_TAB_ACTIVE_CLASS_NAME =
  "bg-[var(--color-background-surface)] hover:bg-[var(--color-background-surface)] shadow-[inset_0_0_0_0.5px_var(--app-rail-inset-border)]";

function SortableThreadTabChip({
  threadId,
  icon,
  labelClassName,
  ...chipProps
}: Omit<ComponentProps<typeof SurfaceTabChip>, "sortable"> & { threadId: ThreadId }) {
  const sortable = useSortable({ id: threadId });
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
        listeners: sortable.listeners,
      }}
    />
  );
}

export function OpenThreadTabStrip(props: {
  activeThreadId: ThreadId;
  onRenameActiveThread: () => void;
}) {
  const { activeThreadId } = props;
  useRecordOpenThreadTab(activeThreadId);
  const tabs = useOpenThreadTabs({ activeThreadId });
  const closeThreadTab = useOpenThreadTabsStore((state) => state.closeThreadTab);
  const moveThreadTab = useOpenThreadTabsStore((state) => state.moveThreadTab);
  // A press that travels becomes a drag; a still one stays a click on the tab or its X.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const activateThreadTab = useActivateThreadTab();
  const { handleNewThread, projects } = useHandleNewThread();
  const readRouteThreadId = useReadRouteThreadId();
  const [enqueueClose] = useState(createOpenThreadTabCloseQueue);
  const navRef = useRef<HTMLElement>(null);
  // Closing tabs with the pointer keeps the survivors at their current width until the
  // pointer leaves the strip (like browser tabs), so the next X lands under the cursor
  // instead of the widened neighbour's title.
  const [frozenTabWidthPx, setFrozenTabWidthPx] = useState<number | null>(null);
  // The tab being switched to paints as active at once, like a pressed sidebar row; the
  // thread itself (a whole chat to render) follows once that frame is on screen.
  const {
    shownKey: shownThreadId,
    select: selectTab,
    cancel: cancelTabSelection,
  } = useOptimisticTabSelection({
    activeKey: activeThreadId,
    hasTab: (threadId) => tabs.some((tab) => tab.threadId === threadId),
    activate: activateThreadTab,
  });

  const freezeTabWidths = () => {
    const nav = navRef.current;
    // Every tab shares one width (same basis and floor), so any of them measures it.
    const tab = nav?.querySelector<HTMLElement>("[data-surface-tab]");
    if (nav?.matches(":hover") && tab) {
      setFrozenTabWidthPx(tab.getBoundingClientRect().width);
    }
  };

  const closeTab = (threadId: ThreadId, projectId: ProjectId) => {
    cancelTabSelection();
    freezeTabWidths();
    void enqueueClose(() => {
      const openThreadIds = useOpenThreadTabsStore.getState().threadIds;
      return {
        // The tabs as clicked, minus any an earlier queued close has since dropped.
        tabs: tabs.filter((tab) => openThreadIds.includes(tab.threadId)),
        closedThreadId: threadId,
        activeThreadId: readRouteThreadId(),
        closeTab: closeThreadTab,
        openTab: activateThreadTab,
        replaceLastTab: replaceLastTabWithFreshChat(() => {
          const project = projects.find((candidate) => candidate.id === projectId);
          return handleNewThread(projectId, {
            fresh: true,
            // Home and Hubs use their container workspace; ordinary projects keep
            // their chosen local/worktree default through handleNewThread.
            ...(project && project.kind !== "project"
              ? { envMode: "local" as const, branch: null, worktreePath: null }
              : {}),
          });
        }),
        readRouteThreadId,
      };
    }).then((result) => {
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Unable to close the tab",
          description: result.error,
        });
      }
    });
  };

  return (
    <nav
      ref={navRef}
      aria-label="Open threads"
      className="flex min-w-0 flex-1"
      style={
        frozenTabWidthPx === null
          ? undefined
          : ({ "--open-thread-tab-frozen-width": `${frozenTabWidthPx}px` } as CSSProperties)
      }
      onPointerLeave={() => setFrozenTabWidthPx(null)}
    >
      {/* The strip is the drag's scroll container: dnd-kit scrolls it while a tab is held
          near either edge, which brings tabs hidden past the header controls into reach. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id) {
            moveThreadTab(active.id as ThreadId, over.id as ThreadId);
          }
        }}
      >
        <SortableContext
          items={tabs.map((tab) => tab.threadId)}
          strategy={horizontalListSortingStrategy}
        >
          <SurfaceTabStrip activeKey={shownThreadId} dividers className="flex-1">
            {tabs.map((tab) => {
              const active = tab.threadId === shownThreadId;
              // A lone unsent draft has nowhere to go: closing it would land on a new chat
              // that is the same draft again.
              const closable = tabs.length > 1 || !tab.isDraft;
              return (
                <SortableThreadTabChip
                  key={tab.threadId}
                  threadId={tab.threadId}
                  active={active}
                  closePlacement="trailing"
                  selectionAria="current"
                  selectOnPointerDown
                  className={cn(
                    frozenTabWidthPx === null
                      ? OPEN_THREAD_TAB_SIZE_CLASS_NAME
                      : OPEN_THREAD_TAB_FROZEN_SIZE_CLASS_NAME,
                    active && OPEN_THREAD_TAB_ACTIVE_CLASS_NAME,
                  )}
                  title={tab.title}
                  label={tab.title}
                  icon={
                    tab.isTerminal ? (
                      <TerminalIcon className="size-3.5 text-[var(--color-text-accent)]" />
                    ) : (
                      <ProviderIcon provider={tab.provider} tone="header" className="size-3.5" />
                    )
                  }
                  closeLabel={`Close ${tab.title}`}
                  onSelect={() => {
                    if (!active) selectTab(tab.threadId);
                  }}
                  onClose={closable ? () => closeTab(tab.threadId, tab.projectId) : undefined}
                  onLabelDoubleClick={
                    tab.threadId === activeThreadId ? props.onRenameActiveThread : undefined
                  }
                />
              );
            })}
          </SurfaceTabStrip>
        </SortableContext>
      </DndContext>
    </nav>
  );
}
