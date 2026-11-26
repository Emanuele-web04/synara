// FILE: CanvasPagesSection.tsx
// Purpose: The Pages list above the layer tree: pages with their icons and dividers in one
//          order. Open a page, add one, rename it in place (double-click or F2), drag pages and
//          dividers to reorder them (or Alt+Arrow keys), and use their context menus. A splitter
//          under the list sets its height (double-click fits it to the pages), remembered here.
// Layer: Canvas editor UI
// Exports: CanvasPagesSection

import type { CanvasWork } from "@synara/contracts";
import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "~/i18n";
import { executionStorage } from "~/lib/hosts/executionStorage";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";
import { AddPlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "../chat/explorerListNavigation";
import { IconButton } from "../ui/icon-button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  setTreeRowDragImage,
  TreeRow,
  treeRowIndent,
  TreeRowRenameInput,
  TreeSectionHeader,
} from "../ui/TreeRow";
import { CanvasAgentPageIndicator } from "./editor/CanvasAgentActivity";
import { useActiveAgentPages } from "./canvasStores";
import { CanvasPageGlyph } from "./canvasPageIcons";
import { showCanvasPageMenu } from "./canvasPageContextMenu";
import { CANVAS_PAGE_TITLE_MAX_LENGTH, useCanvasPageActions } from "./useCanvasPageActions";

/** Page rows line their icons up with the layer rows' (the same empty disclosure lane). */
const PAGE_ROW_INDENT_PX = treeRowIndent(0);
const DRAG_TYPE = "text/x-synara-page";

type Drop = { id: string; edge: "before" | "after" };

/** The pages list's height: one row at least; 224px until the splitter sets one. */
export const CANVAS_PAGES_DEFAULT_HEIGHT = 224;
const PAGES_MIN_HEIGHT = 28;
const PAGES_KEYBOARD_STEP = 16;
const PAGES_HEIGHT_KEY = "synara:canvas-pages-height";

function readPagesHeight(): number {
  try {
    const stored = Number(executionStorage.getItem(PAGES_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= PAGES_MIN_HEIGHT
      ? Math.round(stored)
      : CANVAS_PAGES_DEFAULT_HEIGHT;
  } catch {
    return CANVAS_PAGES_DEFAULT_HEIGHT;
  }
}

function savePagesHeight(height: number) {
  try {
    executionStorage.setItem(PAGES_HEIGHT_KEY, String(height));
  } catch {
    /* A remembered height is a convenience only. */
  }
}

const focusRow = (id: string) =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`[data-page-row="${CSS.escape(id)}"]`)?.focus(),
  );

export function CanvasPagesSection({
  work,
  pageId,
  onSelect,
}: {
  work: CanvasWork;
  pageId: string;
  onSelect: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const activePages = useActiveAgentPages(work.id);
  const pages = useCanvasPageActions(work, pageId, onSelect);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const navigate = useExplorerListNavigation();
  const list = useRef<HTMLDivElement>(null);
  // The list never grows past its pages: the height is a maximum.
  const [height, setHeight] = useState(readPagesHeight);
  const items = pages.items;

  /** The list's full height, every page shown. */
  const contentHeight = () => list.current?.scrollHeight ?? height;
  const clampHeight = (next: number) =>
    Math.round(
      Math.max(PAGES_MIN_HEIGHT, Math.min(next, Math.max(PAGES_MIN_HEIGHT, contentHeight()))),
    );
  const settleHeight = (next: number) => {
    if (list.current) list.current.style.maxHeight = `${next}px`;
    setHeight(next);
    savePagesHeight(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = list.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = element.getBoundingClientRect().height;
    let shown = startHeight;
    const overlay = createPanelResizeOverlay("row-resize");
    let detach: (() => void) | null = null;
    const finish = () => {
      detach?.();
      removePanelResizeOverlay(overlay);
      document.body.style.removeProperty("user-select");
      settleHeight(shown);
    };
    document.body.style.userSelect = "none";
    // While dragging only the list's DOM height changes: nothing re-renders.
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (move) => {
        shown = clampHeight(startHeight + move.clientY - startY);
        element.style.maxHeight = `${shown}px`;
      },
      onRelease: finish,
      onAbort: finish,
    });
  };
  const writable = !pages.readOnly;

  /** Where a drop lands: right before this row, or before the row after it. */
  const beforeIdFor = ({ id, edge }: Drop) =>
    edge === "before" ? id : (items[items.findIndex((item) => item.id === id) + 1]?.id ?? null);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).getAttribute("data-page-row");
    const at = items.findIndex((item) => item.id === id);
    const item = items[at];
    if (!item) return;
    // Alt+↑/↓ moves the focused page or divider one step (Synara's keyboard reorder).
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (!writable) return;
      const beforeId = event.key === "ArrowUp" ? items[at - 1]?.id : (items[at + 2]?.id ?? null);
      if (beforeId === undefined || (event.key === "ArrowDown" && at === items.length - 1)) return;
      void pages.move(item.id, beforeId).then(() => focusRow(item.id));
    } else if (item.kind === "divider") navigate(event);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(item.id);
    } else if (event.key === "F2" && writable) {
      event.preventDefault();
      setRenaming(item.id);
    } else navigate(event);
  };

  const dragProps = (id: string) =>
    writable && renaming !== id
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLDivElement>) => {
            setDragging(id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, id);
            setTreeRowDragImage(event);
          },
          onDragEnd: () => {
            setDragging(null);
            setDrop(null);
          },
        }
      : {};
  const dropProps = (id: string) => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!dragging) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      const edge = event.clientY < box.top + box.height / 2 ? "before" : "after";
      setDrop((current) => (current?.id === id && current.edge === edge ? current : { id, edge }));
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const moving = dragging;
      setDragging(null);
      setDrop(null);
      if (moving && drop) void pages.move(moving, beforeIdFor(drop));
    },
  });
  const openMenu = (item: (typeof items)[number], event: MouseEvent) => {
    event.preventDefault();
    void showCanvasPageMenu({
      t,
      pages,
      item,
      position: { x: event.clientX, y: event.clientY },
      onRename: setRenaming,
    });
  };

  return (
    <section className="relative flex shrink-0 flex-col border-b border-border pt-1 pb-1.5">
      <TreeSectionHeader
        title={t("workspace:canvasPages")}
        disclosure={{ open, onToggle: () => setOpen((value) => !value) }}
      >
        {pages.readOnly ? null : (
          <IconButton
            label={t("workspace:canvasAddPage")}
            tooltip={t("workspace:canvasAddPage")}
            disabled={!pages.canCreate}
            onClick={() => {
              setOpen(true);
              void pages.create().then((id) => {
                if (id) setRenaming(id);
              });
            }}
          >
            <AddPlusIcon />
          </IconButton>
        )}
      </TreeSectionHeader>
      <DisclosureRegion open={open}>
        <div
          ref={list}
          role="listbox"
          aria-label={t("workspace:canvasPages")}
          data-canvas-pages-list=""
          className="overflow-y-auto"
          style={{ maxHeight: height }}
          onKeyDown={onListKeyDown}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
          }}
        >
          {items.map((item) => {
            const line = drop?.id === item.id ? drop.edge : null;
            if (item.kind === "divider")
              return (
                <TreeRow
                  key={item.id}
                  {...EXPLORER_ROW_PROPS}
                  role="option"
                  aria-label={t("workspace:canvasDivider")}
                  aria-disabled
                  aria-selected={false}
                  tabIndex={-1}
                  data-page-row={item.id}
                  data-page-divider=""
                  indent={PAGE_ROW_INDENT_PX}
                  className={cn("h-3 hover:bg-transparent", dragging === item.id && "opacity-40")}
                  drop={line}
                  label={<span className="-ms-1.5 block h-px bg-border" />}
                  onContextMenu={(event) => openMenu(item, event)}
                  {...dragProps(item.id)}
                  {...dropProps(item.id)}
                />
              );
            const page = item.page;
            const current = page.id === pageId;
            return (
              <TreeRow
                key={page.id}
                {...EXPLORER_ROW_PROPS}
                role="option"
                aria-selected={current}
                tabIndex={current ? 0 : -1}
                data-page-row={page.id}
                data-canvas-page-current={current ? "" : undefined}
                indent={PAGE_ROW_INDENT_PX}
                disclosure={null}
                // The open page is the selected row, like the sidebar's open chat.
                selected={current}
                className={cn(dragging === page.id && "opacity-40")}
                drop={line}
                // A page an agent is working on shows the activity indicator instead of its icon.
                icon={
                  activePages.has(page.id) ? (
                    <CanvasAgentPageIndicator />
                  ) : (
                    <CanvasPageGlyph icon={page.icon} className="size-3.5" />
                  )
                }
                label={page.title}
                editor={
                  renaming === page.id ? (
                    <TreeRowRenameInput
                      defaultValue={page.title}
                      label={t("workspace:canvasRenamePage")}
                      maxLength={CANVAS_PAGE_TITLE_MAX_LENGTH}
                      onCancel={() => setRenaming(null)}
                      onCommit={(value) => {
                        setRenaming(null);
                        const title = value.trim();
                        if (title && title !== page.title) void pages.rename(page.id, title);
                      }}
                    />
                  ) : undefined
                }
                onClick={() => {
                  if (!current) onSelect(page.id);
                }}
                onDoubleClick={() => {
                  if (writable) setRenaming(page.id);
                }}
                onContextMenu={(event) => openMenu(item, event)}
                {...dragProps(page.id)}
                {...dropProps(page.id)}
              />
            );
          })}
        </div>
      </DisclosureRegion>
      {open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("workspace:canvasResizePages")}
          aria-valuenow={height}
          aria-valuemin={PAGES_MIN_HEIGHT}
          tabIndex={0}
          data-canvas-pages-splitter=""
          className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize outline-none before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-transparent hover:before:bg-ring focus-visible:before:h-0.5 focus-visible:before:bg-ring"
          onPointerDown={startResize}
          onDoubleClick={() => settleHeight(Math.max(PAGES_MIN_HEIGHT, contentHeight()))}
          onKeyDown={(event) => {
            const step =
              event.key === "ArrowUp"
                ? -PAGES_KEYBOARD_STEP
                : event.key === "ArrowDown"
                  ? PAGES_KEYBOARD_STEP
                  : 0;
            if (step === 0) return;
            event.preventDefault();
            const current = list.current?.getBoundingClientRect().height ?? height;
            settleHeight(clampHeight(current + step));
          }}
        />
      )}
    </section>
  );
}
