// FILE: AppRail.tsx
// Purpose: The rail layout's fixed icon tab strip (Home, Spaces, route destinations, Settings).
// Layer: App shell component
// Exports: AppRail, AppRailItem, AppRailPortal, AppRailSlotProvider
// Depends on: SidebarIconButton and the shared sidebar row tokens. ThreadSidebar owns the
//             items and their handlers and portals the rail into the slot the route shell
//             places left of the panel, so no handler moves out of ThreadSidebar.

import {
  type ComponentType,
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
} from "react";
import { createPortal } from "react-dom";

import { TasksCoachmark } from "./OneTimeCoachmark";
import type { RailItemId } from "~/appRail.logic";
import { createCentralIconComponent } from "~/lib/central-icons";
import {
  ClockIcon,
  CodeReviewIcon,
  FoldersIcon,
  HomeIcon,
  HubActiveIcon,
  HubIcon,
  InboxIcon,
  TasksIcon,
} from "~/lib/icons";
import { projectAppearanceKey, type ProjectAppearance } from "~/lib/projectAppearance";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
} from "~/sidebarRowStyles";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import type { SidebarActionBadge } from "./Sidebar.logic";
import { SidebarIconButton } from "./SidebarIconButton";

type RailGlyph = ComponentType<{ className?: string }>;
/** A rail button's glyph pair: outline at rest, filled while active (like Codex). */
export type AppRailGlyphs = { readonly idle: RailGlyph; readonly active: RailGlyph };

// Glyph components are cached so a shortcut keeps one component identity across renders.
const glyphCache = new Map<string, AppRailGlyphs>();

/** Rail glyphs for a Central icon name (rail items and Space shortcuts). */
export function railCentralGlyphs(name: string): AppRailGlyphs {
  const cacheKey = `central:${name}`;
  const cached = glyphCache.get(cacheKey);
  if (cached) return cached;
  const glyphs = {
    idle: createCentralIconComponent(name),
    active: createCentralIconComponent(name, "fill"),
  };
  glyphCache.set(cacheKey, glyphs);
  return glyphs;
}

/** Rail glyphs for a project shortcut: the same glyph its sidebar row shows. */
export function railProjectGlyphs(
  cwd: string,
  appearance: ProjectAppearance | null,
): AppRailGlyphs {
  const cacheKey = `project:${cwd}:${projectAppearanceKey(appearance)}`;
  const cached = glyphCache.get(cacheKey);
  if (cached) return cached;
  function ProjectRailGlyph({ className }: { className?: string }) {
    return (
      <ProjectSidebarIcon
        cwd={cwd}
        expanded={false}
        appearance={appearance}
        {...(className ? { glyphClassName: className } : {})}
      />
    );
  }
  const glyphs = { idle: ProjectRailGlyph, active: ProjectRailGlyph };
  glyphCache.set(cacheKey, glyphs);
  return glyphs;
}

/** A rail item whose glyph has no solid twin: the same icon at rest and while active. */
const sameGlyphs = (glyph: RailGlyph): AppRailGlyphs => ({ idle: glyph, active: glyph });

/** Hugeicons rail items. Only Hubs ship a solid active glyph; the rest match at rest and active. */
type HugeiconRailItemId =
  | "home"
  | "inbox"
  | "pullRequests"
  | "automations"
  | "tasks"
  | "spaces"
  | "studio";
const RAIL_HUGEICON_GLYPHS: Record<HugeiconRailItemId, AppRailGlyphs> = {
  home: sameGlyphs(HomeIcon),
  inbox: sameGlyphs(InboxIcon),
  pullRequests: sameGlyphs(CodeReviewIcon),
  automations: sameGlyphs(ClockIcon),
  tasks: sameGlyphs(TasksIcon),
  spaces: sameGlyphs(FoldersIcon),
  // Hubs (stored id "studio"): Hugeicons circles, with their own solid active glyph.
  studio: { idle: HubIcon, active: HubActiveIcon },
};

/** Central glyphs matching the Codex rail for the remaining fixed rail items. */
const RAIL_ITEM_GLYPH_NAMES: Record<Exclude<RailItemId, HugeiconRailItemId>, string> = {
  kanban: "columns-3-wide",
  settings: "settings-gear-4",
};

function isHugeiconRailItem(id: RailItemId): id is HugeiconRailItemId {
  return id in RAIL_HUGEICON_GLYPHS;
}

export function railItemGlyphs(id: RailItemId): AppRailGlyphs {
  if (isHugeiconRailItem(id)) return RAIL_HUGEICON_GLYPHS[id];
  return railCentralGlyphs(RAIL_ITEM_GLYPH_NAMES[id]);
}

/** The rail's "more" glyph (Codex's "…"). */
export const RAIL_MORE_GLYPHS = railCentralGlyphs("dot-grid-1x3-horizontal");

export type AppRailItem = {
  /** A rail item id, or a shortcut key ("space:…" / "project:…"). */
  readonly id: string;
  readonly glyphs: AppRailGlyphs;
  readonly label: string;
  readonly badge: SidebarActionBadge | null;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onMouseEnter?: (() => void) | undefined;
  readonly onFocus?: (() => void) | undefined;
};

type AppRailProps = {
  items: ReadonlyArray<AppRailItem>;
  /** Spaces and projects the user added from the "…" menu, below the fixed items. */
  shortcuts: ReadonlyArray<AppRailItem>;
  /** The "…" menu trigger, after the shortcuts. */
  moreSlot?: ReactNode;
  bottomItems: ReadonlyArray<AppRailItem>;
  /** Rendered above the bottom items (the usage rings, then the Help menu like Codex's rail). */
  bottomSlot?: ReactNode;
  /** Right-click on the rail (offers "Customize"). */
  onContextMenu?: ((event: MouseEvent) => void) | undefined;
};

/** Rail glyph size, shared with controls rendered into the rail slot (the Help menu). */
export const APP_RAIL_GLYPH_CLASS_NAME = "size-5";

/** Rail button box and active/idle tone, shared with controls rendered into the rail slot.
 *  Idle glyphs rest on the section-label grey; hover and the active item are full ink. */
export function appRailButtonClassName(active: boolean): string {
  return cn(
    "size-9 rounded-lg",
    active
      ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
      : cn(SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
  );
}

function AppRailButton({
  item,
  slidingBackground = false,
}: {
  item: AppRailItem;
  slidingBackground?: boolean;
}) {
  const label = item.badge ? `${item.label} · ${item.badge.accessibleLabel}` : item.label;
  const glyphs = item.glyphs;
  const button = (
    <SidebarIconButton
      icon={item.active ? glyphs.active : glyphs.idle}
      iconClassName={cn(APP_RAIL_GLYPH_CLASS_NAME, item.active && "app-rail-icon-enter")}
      label={label}
      size="lg"
      tooltip={item.id === "tasks" ? undefined : label}
      tooltipSide="right"
      aria-current={item.active ? "page" : undefined}
      className={cn(
        appRailButtonClassName(item.active),
        slidingBackground && item.active && "bg-transparent hover:bg-transparent",
      )}
      onClick={item.onSelect}
      {...(item.onMouseEnter ? { onMouseEnter: item.onMouseEnter } : {})}
      {...(item.onFocus ? { onFocus: item.onFocus } : {})}
    />
  );
  return (
    <div className="relative shrink-0">
      {item.id === "tasks" ? <TasksCoachmark tooltip={label}>{button}</TasksCoachmark> : button}
      {/* Same corner dot as the Activity bell's unread marker; the count is in the tooltip. */}
      {item.badge ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-text-accent)]"
        />
      ) : null}
    </div>
  );
}

export function AppRail({
  items,
  shortcuts,
  moreSlot,
  bottomItems,
  bottomSlot,
  onContextMenu,
}: AppRailProps) {
  const activeIndex = items.findIndex((item) => item.active);
  return (
    <nav
      aria-label="Primary"
      onContextMenu={onContextMenu}
      className="flex w-(--app-rail-width) shrink-0 flex-col items-center gap-1.5 pt-2.5 pb-2.5 font-system-ui"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto [scrollbar-width:none]">
        <div className="relative flex shrink-0 flex-col items-center gap-1.5">
          {activeIndex >= 0 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute top-0 size-9 rounded-lg bg-[var(--sidebar-selected)] transition-transform duration-220 ease-out motion-reduce:transition-none"
              // Keep the stride aligned with the size-9 buttons and gap-1.5 above.
              style={{ transform: `translateY(${activeIndex * 2.625}rem)` }}
            />
          ) : null}
          {items.map((item) => (
            <AppRailButton key={item.id} item={item} slidingBackground />
          ))}
        </div>
        {shortcuts.length > 0 ? (
          <>
            <div
              aria-hidden
              className="my-0.5 h-px w-5 shrink-0 bg-[var(--app-rail-inset-border)]"
            />
            {shortcuts.map((item) => (
              <AppRailButton key={item.id} item={item} />
            ))}
          </>
        ) : null}
        {moreSlot}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        {bottomSlot}
        {bottomItems.map((item) => (
          <AppRailButton key={item.id} item={item} />
        ))}
      </div>
    </nav>
  );
}

const AppRailSlotContext = createContext<HTMLElement | null>(null);

/** Provided by the route shell with the element the rail renders into. */
export const AppRailSlotProvider = AppRailSlotContext.Provider;

/** The element the rail renders into (null until the shell mounts); anchors rail popovers. */
export function useAppRailSlot(): HTMLElement | null {
  return useContext(AppRailSlotContext);
}

/** Renders the rail into the shell's slot; nothing until the slot is mounted. */
export function AppRailPortal(props: AppRailProps) {
  const slot = useContext(AppRailSlotContext);
  return slot ? createPortal(<AppRail {...props} />, slot) : null;
}
