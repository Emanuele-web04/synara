// FILE: SpaceSwitcher.tsx
// Purpose: Arc-style horizontal Space tabs with reordering and tab management.

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SPACE_NAME_MAX_LENGTH, type ProjectId, type SpaceId } from "@synara/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { Space } from "~/types";
import { createClientPointMenuAnchor } from "~/lib/clientPointMenuAnchor";
import {
  VOID_SPACE_ICON,
  VOID_SPACE_NAME,
  resolveActiveSpaceId,
  spaceDisplayName,
  spaceKey,
} from "~/lib/spaceGrouping";
import { cn } from "~/lib/utils";
import { PencilIcon, PlusIcon, Trash2 } from "~/lib/icons";
import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "~/sidebarRowStyles";
import { SpaceIcon, type SpaceIconValue } from "./SpaceIcon";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
  SidebarContextMenuIcon,
} from "./sidebarContextMenuStyles";
import { Menu, MenuGroup, MenuItem } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type SpaceActivityTone = "attention" | "running" | "completed";

/** HTML5 drag payload for filing a project by dropping it onto a space tab. */
export const PROJECT_SPACE_DRAG_MIME = "application/x-synara-project";

function readDraggedProjectId(event: DragEvent): ProjectId | null {
  try {
    const payload = JSON.parse(event.dataTransfer.getData(PROJECT_SPACE_DRAG_MIME)) as {
      projectId?: string;
    } | null;
    return payload?.projectId ? (payload.projectId as ProjectId) : null;
  } catch {
    return null;
  }
}

function isProjectDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(PROJECT_SPACE_DRAG_MIME);
}

/**
 * A tab dot is a whole space summarised into one pixel, so it has to speak the same
 * colour language as the per-thread status dots it stands in for (see the `dotClass`
 * values in Sidebar.logic.ts): amber = you are blocking something, sky = work in
 * flight, emerald = finished. Tones are per-theme because a 400-weight dot dies on
 * the light sidebar and glares on the dark one.
 */
const SPACE_ACTIVITY_DOT_CLASS_NAME: Record<SpaceActivityTone, string> = {
  attention: "bg-amber-500 dark:bg-amber-300/90",
  running: "bg-sky-500 dark:bg-sky-300/80",
  completed: "bg-emerald-500 dark:bg-emerald-300/90",
};

/** Spoken and hover wording for a tone. The internal tone keys must never reach a user. */
const SPACE_ACTIVITY_LABEL: Record<SpaceActivityTone, string> = {
  attention: "Needs attention",
  running: "Working",
  completed: "Done",
};

/**
 * Width of the edge fade that signals more tabs are scrolled out of view. The overflow
 * distances are seeded at 0 here (no fade) and then written straight onto the node by
 * `useTabStripOverflow`; declaring them up front keeps the mask valid on first paint.
 */
const TAB_STRIP_FADE_CLASS_NAME =
  "mask-l-from-[calc(100%-min(var(--fade-size),var(--space-overflow-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--space-overflow-end)))] [--fade-size:1.25rem] [--space-overflow-end:0px] [--space-overflow-start:0px]";

const SPACE_TAB_CLASS_NAME =
  "relative flex size-6 shrink-0 cursor-pointer touch-none items-center justify-center rounded-md text-muted-foreground/70 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Hover and selection share one token (`--sidebar-accent`/`--sidebar-accent-active`
 * resolve to the same 4% wash), so an icon-only tab cannot lean on background alone
 * the way a labelled sidebar row does. Selection is carried by the hairline ring and
 * full-strength glyph on top of that wash. The ring is inset: drawn outside it would
 * make the active tab render 26px next to a 24px hovered neighbour.
 */
const SPACE_TAB_ACTIVE_CLASS_NAME =
  "bg-[var(--sidebar-accent-active)] text-[var(--sidebar-accent-foreground)] ring-1 ring-border/70 ring-inset";

function SpaceActivityDot({ tone }: { tone: SpaceActivityTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        // The ring punches the dot out of the tab surface beneath it.
        "pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-[var(--sidebar)]",
        SPACE_ACTIVITY_DOT_CLASS_NAME[tone],
      )}
    />
  );
}

type SortableState = ReturnType<typeof useSortable>;

interface SpaceTabSortable {
  setNodeRef: SortableState["setNodeRef"];
  style: CSSProperties;
  isDragging: boolean;
  /**
   * Pointer activators only. dnd-kit's `attributes` are deliberately not carried across —
   * see `SortableSpaceTab`.
   */
  listeners: SortableState["listeners"];
}

function SpaceTab(props: {
  icon: SpaceIconValue;
  name: string;
  /** Extra tooltip/spoken context that the icon alone cannot carry (Void). */
  hint?: string;
  /** Rendered jump-chord label (e.g. "⌘⌥2") appended to the tooltip. */
  shortcutLabel?: string | null;
  active: boolean;
  activityTone: SpaceActivityTone | null;
  onSelect: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Files the dragged project into this tab's space. */
  onProjectDrop?: (projectId: ProjectId) => void;
  sortable?: SpaceTabSortable;
}) {
  const toneLabel = props.activityTone ? SPACE_ACTIVITY_LABEL[props.activityTone] : null;
  const detail = toneLabel ?? props.hint ?? null;
  // Counter, not a boolean: dragenter/dragleave also fire for the tab's child spans, and
  // a boolean would flicker off while the pointer crosses them.
  const dragDepthRef = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const { onProjectDrop } = props;

  const dropHandlers = onProjectDrop
    ? {
        onDragOver: (event: DragEvent<HTMLButtonElement>) => {
          if (!isProjectDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (event: DragEvent<HTMLButtonElement>) => {
          if (!isProjectDrag(event)) return;
          dragDepthRef.current += 1;
          setDropActive(true);
        },
        onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
          if (!isProjectDrag(event)) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        },
        onDrop: (event: DragEvent<HTMLButtonElement>) => {
          dragDepthRef.current = 0;
          setDropActive(false);
          const projectId = readDraggedProjectId(event);
          if (!projectId) return;
          event.preventDefault();
          onProjectDrop(projectId);
        },
      }
    : {};

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            {...props.sortable?.listeners}
            ref={props.sortable?.setNodeRef}
            type="button"
            role="tab"
            data-space-tab
            aria-selected={props.active}
            // Roving tabindex: the strip is one tab stop, arrows move within it.
            tabIndex={props.active ? 0 : -1}
            aria-label={[props.name, props.hint, toneLabel].filter(Boolean).join(", ")}
            onClick={props.onSelect}
            {...(props.onContextMenu ? { onContextMenu: props.onContextMenu } : {})}
            {...dropHandlers}
            {...(props.sortable ? { style: props.sortable.style } : {})}
            className={cn(
              SPACE_TAB_CLASS_NAME,
              props.active && SPACE_TAB_ACTIVE_CLASS_NAME,
              props.sortable?.isDragging && "z-20 opacity-70",
              dropActive && "bg-[var(--sidebar-accent)] ring-1 ring-ring ring-inset",
            )}
          />
        }
      >
        <SpaceIcon icon={props.icon} className="size-3.5" />
        {props.activityTone ? <SpaceActivityDot tone={props.activityTone} /> : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.name}
        {detail ? <span className="text-muted-foreground/70"> · {detail}</span> : null}
        {props.shortcutLabel ? (
          <span className="text-muted-foreground/70"> · {props.shortcutLabel}</span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function SortableSpaceTab(props: {
  space: Space;
  shortcutLabel: string | null;
  active: boolean;
  activityTone: SpaceActivityTone | null;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onProjectDrop: (projectId: ProjectId) => void;
}) {
  // `sortable.attributes` is dropped whole, not filtered: `role`/`tabIndex`/`aria-pressed`
  // fight the tab role and roving tabindex, and the rest advertise a keyboard drag that
  // does not exist here — the strip registers a PointerSensor only, so dnd-kit's "press
  // the space bar to pick up" instructions would send a screen-reader user into the
  // button's onClick and switch Space. Reordering is pointer-only, so it stays unspoken.
  const sortable = useSortable({ id: props.space.id });

  return (
    <SpaceTab
      icon={props.space.icon}
      name={props.space.name}
      shortcutLabel={props.shortcutLabel}
      active={props.active}
      activityTone={props.activityTone}
      onSelect={props.onSelect}
      onContextMenu={props.onContextMenu}
      onProjectDrop={props.onProjectDrop}
      sortable={{
        setNodeRef: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
        },
        isDragging: sortable.isDragging,
        listeners: sortable.listeners,
      }}
    />
  );
}

/**
 * Tracks how far the strip is scrolled past each edge so the fade only appears on the
 * side that actually has hidden tabs. Mirrors the overflow-driven fade in ScrollArea,
 * which cannot be reused here: its viewport is focusable and would inject a tab stop
 * into the middle of the tablist.
 *
 * The distances are written onto the node as custom properties rather than held in
 * state: this runs on every scroll frame, and re-rendering the whole strip (each tab
 * is a tooltip and a dnd-kit sortable) to move a gradient by a pixel is work the
 * compositor already does for free.
 */
function useTabStripOverflow(dependencyKey: string) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    const update = () => {
      node.style.setProperty("--space-overflow-start", `${Math.round(node.scrollLeft)}px`);
      node.style.setProperty(
        "--space-overflow-end",
        `${Math.round(Math.max(0, node.scrollWidth - node.clientWidth - node.scrollLeft))}px`,
      );
    };

    update();
    node.addEventListener("scroll", update, { passive: true });
    // Catches the strip being resized by the sidebar; `dependencyKey` covers tabs
    // being added or removed, which leaves the scroller's own box unchanged.
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [dependencyKey]);

  return scrollerRef;
}

/**
 * The active space's name doubles as its rename affordance: double-click edits in
 * place, Enter or blur commits when valid, Escape cancels. Void is not a stored row,
 * so it renders as a plain label.
 */
function SpaceNameLabel(props: {
  activeSpace: Space | null;
  displayName: string;
  existingNames: ReadonlyArray<string>;
  onRename: (space: Space, name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const space = props.activeSpace;

  if (!space || draft === null) {
    return (
      <span
        className="truncate"
        {...(space
          ? { onDoubleClick: () => setDraft(space.name), title: "Double-click to rename" }
          : {})}
      >
        {props.displayName}
      </span>
    );
  }

  const trimmed = draft.trim();
  const isValid =
    trimmed.length > 0 &&
    trimmed.toLowerCase() !== "void" &&
    !props.existingNames.some(
      (name) => name !== space.name && name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
  const commit = () => {
    if (isValid && trimmed !== space.name) props.onRename(space, trimmed);
    setDraft(null);
  };

  return (
    <input
      value={draft}
      autoFocus
      maxLength={SPACE_NAME_MAX_LENGTH}
      aria-label="Space name"
      aria-invalid={!isValid}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
      className={cn(
        "-mx-0.5 w-full min-w-0 rounded-sm bg-transparent px-0.5 outline-hidden ring-1",
        isValid ? "ring-ring/40" : "ring-destructive/60",
      )}
    />
  );
}

interface SpaceSwitcherProps {
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  activityBySpaceId: ReadonlyMap<SpaceId | null, SpaceActivityTone>;
  onSelect: (spaceId: SpaceId | null) => void;
  onCreate: () => void;
  onEdit: (space: Space) => void;
  onDelete: (space: Space) => void;
  onReorder: (orderedSpaceIds: ReadonlyArray<SpaceId>, movedSpaceId: SpaceId) => void;
  onRenameSpace: (space: Space, name: string) => void;
  onDropProject: (projectId: ProjectId, spaceId: SpaceId | null) => void;
  /** Jump-chord label for a tab position (0 = Void), shown in the tab tooltip. */
  jumpShortcutLabelForTab?: (tabIndex: number) => string | null;
}

export function SpaceSwitcher(props: SpaceSwitcherProps) {
  // Zero spaces means zero chrome: the strip (and the Void tab it would carry) only
  // exists once there is a second place for a project to be. Creation lives in the
  // project context menu and the command palette until then.
  if (props.spaces.length === 0) {
    return null;
  }
  return <SpaceSwitcherStrip {...props} />;
}

function SpaceSwitcherStrip(props: SpaceSwitcherProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [contextState, setContextState] = useState<{
    space: Space;
    position: { x: number; y: number };
  } | null>(null);
  const contextAnchor = useMemo(
    () => (contextState ? createClientPointMenuAnchor(contextState.position) : null),
    [contextState],
  );
  const spaceOrderKey = props.spaces.map((space) => space.id).join();
  const scrollerRef = useTabStripOverflow(spaceOrderKey);
  /**
   * `activeSpaceId` can name a Space this strip has no tab for: the selection is restored
   * from session storage synchronously on reload while `spaces` is still empty, and another
   * window can delete the Space we are sitting in. Every other Space id in the app resolves
   * to "unassigned" when it cannot be found, so this one does too — otherwise the header
   * would name one Space while no tab looked selected, and, because the tab stop rides on
   * the selected tab, the whole strip would silently drop out of the Tab order. Presenting
   * Void is also the state the store reconciles itself to a moment later.
   */
  const activeSpaceId = resolveActiveSpaceId(props.activeSpaceId, props.spaces);
  const activeSpace = activeSpaceId
    ? (props.spaces.find((space) => space.id === activeSpaceId) ?? null)
    : null;
  const activeSpaceName = spaceDisplayName(activeSpaceId, props.spaces);

  /**
   * Manual activation: the arrows move focus and Enter/Space commits (native on a
   * `<button>`). Tabs normally select as you arrow onto them, but selecting a Space
   * here is a route change that tears down and restores an entire working context —
   * sweeping the strip would fire one navigation per keypress and leave the loser
   * contexts recorded as "most recent". Users who want to sweep have the dedicated
   * previous/next-space shortcuts, which are built for exactly that.
   */
  const handleTabStripKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-space-tab]"),
    );
    if (tabs.length === 0) return;
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowLeft"
            ? (Math.max(currentIndex, 0) - 1 + tabs.length) % tabs.length
            : (Math.max(currentIndex, -1) + 1) % tabs.length;
    event.preventDefault();
    tabs[nextIndex]?.focus();
  }, []);

  // Void sits outside the scroller, so it can never need revealing.
  useEffect(() => {
    if (activeSpaceId === null) return;
    scrollerRef.current
      ?.querySelector<HTMLButtonElement>('[data-space-tab][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSpaceId, scrollerRef, spaceOrderKey]);

  return (
    <div className="mb-2">
      <div
        className={cn(
          "flex h-7 min-w-0 items-center px-2 py-0.5",
          SIDEBAR_SECTION_LABEL_CLASS_NAME,
        )}
      >
        <SpaceNameLabel
          // Keyed by the active space so switching spaces mid-edit discards the draft
          // instead of leaving an input bound to a different space's rename handler.
          key={spaceKey(activeSpaceId)}
          activeSpace={activeSpace}
          displayName={activeSpaceName}
          existingNames={props.spaces.map((space) => space.name)}
          onRename={props.onRenameSpace}
        />
      </div>

      {/* px-1 keeps a 24px tab's 14px glyph centred on the same x (16px) as the
          leading glyph of a project row below, so the two lists share one optical margin.
          gap-1: adjacent washed tabs (active next to hovered) read as one blob at 2px. */}
      <div className="flex items-center gap-1 px-1">
        <div
          role="tablist"
          aria-label="Spaces"
          aria-orientation="horizontal"
          className="flex min-w-0 flex-1 items-center gap-1"
          onKeyDown={handleTabStripKeyDown}
        >
          <SpaceTab
            icon={VOID_SPACE_ICON}
            name={VOID_SPACE_NAME}
            hint="Unassigned projects"
            shortcutLabel={props.jumpShortcutLabelForTab?.(0) ?? null}
            active={activeSpaceId === null}
            activityTone={props.activityBySpaceId.get(null) ?? null}
            onSelect={() => props.onSelect(null)}
            onProjectDrop={(projectId) => props.onDropProject(projectId, null)}
          />

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              const previousIndex = props.spaces.findIndex((space) => space.id === active.id);
              const nextIndex = props.spaces.findIndex((space) => space.id === over.id);
              if (previousIndex < 0 || nextIndex < 0) return;
              const reordered = arrayMove([...props.spaces], previousIndex, nextIndex);
              props.onReorder(
                reordered.map((space) => space.id),
                active.id as SpaceId,
              );
            }}
          >
            <div
              ref={scrollerRef}
              className={cn(
                "flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                TAB_STRIP_FADE_CLASS_NAME,
              )}
            >
              <SortableContext
                items={props.spaces.map((space) => space.id)}
                strategy={horizontalListSortingStrategy}
              >
                {props.spaces.map((space, index) => (
                  <SortableSpaceTab
                    key={space.id}
                    space={space}
                    shortcutLabel={props.jumpShortcutLabelForTab?.(index + 1) ?? null}
                    active={activeSpaceId === space.id}
                    activityTone={props.activityBySpaceId.get(space.id) ?? null}
                    onSelect={() => props.onSelect(space.id)}
                    onProjectDrop={(projectId) => props.onDropProject(projectId, space.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextState({
                        space,
                        position: { x: event.clientX, y: event.clientY },
                      });
                    }}
                  />
                ))}
              </SortableContext>
            </div>
          </DndContext>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New space"
                onClick={props.onCreate}
                className={cn(SPACE_TAB_CLASS_NAME, "text-muted-foreground/55")}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">New space</TooltipPopup>
        </Tooltip>
      </div>

      {contextState && contextAnchor ? (
        <Menu open onOpenChange={(open) => !open && setContextState(null)}>
          <ComposerPickerMenuPopup
            anchor={contextAnchor}
            align="start"
            side="bottom"
            sideOffset={0}
            className={SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME}
          >
            <MenuGroup>
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setContextState(null);
                  props.onEdit(contextState.space);
                }}
              >
                <SidebarContextMenuIcon icon={PencilIcon} />
                <span>Edit space…</span>
              </MenuItem>
              {/* Neutral, not red: deleting a space only files its projects back into
                  Void, and the sibling project menu keeps its harder "Delete project"
                  neutral too. Reddening the milder action would invert the hierarchy. */}
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setContextState(null);
                  props.onDelete(contextState.space);
                }}
              >
                <SidebarContextMenuIcon icon={Trash2} />
                <span>Delete space</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
