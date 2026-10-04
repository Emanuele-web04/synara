// FILE: chatHeaderControls.tsx
// Purpose: Single source of truth for chat-header toolbar control sizing, radius,
//          and tone so text buttons, icon-only buttons, and toggles line up on one
//          baseline regardless of the underlying Button/Toggle variant.
// Layer: Chat header UI primitive
// Exports: ChatHeaderButton, ChatHeaderIconButton, tone helper, and the raw class
//          tokens for call sites that can't use the wrappers (e.g. Toggle, segmented
//          groups, render-prop triggers, right-dock tabs).
// Why: The header previously mixed three heights (24/28/32px) and two radii because
//      each control leaned on a different Button size + variant compound. Centralizing
//      the chrome here keeps the row visually coherent and lets new controls opt in
//      with one import instead of re-deriving the magic classes.

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  forwardRef,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";

import { CentralIcon } from "~/lib/central-icons";
import { type LucideIcon } from "~/lib/icons";
import { scrollTabIntoView } from "~/lib/tabStrip";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Fixed height of the top chrome bar shared by the chat header, the diff panel
 * header, and the right-dock tab strip. Keeping these on one token ensures their
 * bottom borders line up across the vertical pane divider.
 *
 * Tall enough that the vertically-centered controls clear the macOS title bar with
 * breathing room below them rather than hugging the very top of the window.
 *
 * The pixel height is owned by `CHAT_SURFACE_HEADER_HEIGHT_PX` in
 * `@synara/shared/desktopChrome` (the single source of truth the Electron main
 * process also reads to center the native traffic lights). Tailwind only emits CSS
 * for class names it can scan literally, so the class stays a literal here — but its
 * TYPE is derived from the shared number, so the build fails if the two ever drift.
 */
export const CHAT_SURFACE_HEADER_HEIGHT_CLASS: `h-[${typeof CHAT_SURFACE_HEADER_HEIGHT_PX}px]` =
  "h-[44px]";

/**
 * Standard horizontal inset for a chat-surface top bar (chat / workspace / settings
 * headers all sit their content at this x). Kept as one token so the leading controls
 * line up across surfaces and the inset is tuned in a single place.
 */
export const CHAT_SURFACE_HEADER_PADDING_X_CLASS = "px-3 sm:px-5";

/**
 * Bottom hairline shared by every chat-surface chrome bar (chat header, workspace
 * header, dock pane + tab strip headers, diff panel header).
 * Implemented as the `.chat-surface-divider` component class (a 1px background gradient,
 * see index.css) rather than a CSS border: it reads from the SAME `--app-surface-divider`
 * token as the vertical sidebar↔chat seam, and — because it's a gradient — the seam corner
 * retracts it 1px so the horizontal hairline butts against the vertical seam instead of
 * crossing it (overlapping 1px lines double their alpha into a brighter dot). Apply
 * alongside {@link CHAT_SURFACE_HEADER_HEIGHT_CLASS} so heights and dividers line up.
 */
export const CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME = "chat-surface-divider";

/**
 * Standard chat-surface chrome-bar row: the shared flex baseline + fixed height + bottom
 * hairline that the simple headers all repeat (empty-state chat header, dock pane header,
 * right-dock tab strip). Call sites add only their own gap/padding
 * and extras (drag-region, traffic-light gutter). Headers with bespoke layout (the main
 * chat header with its split toolbar, the diff panel header with `justify-between`) compose
 * {@link CHAT_SURFACE_HEADER_HEIGHT_CLASS} + {@link CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME}
 * directly instead of forcing this baseline.
 */
export const CHAT_SURFACE_HEADER_ROW_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
);

/**
 * Force header control glyphs to full-strength foreground. The base Button caps
 * SVGs at `opacity-80` and the `chrome` variant tints them with the muted
 * `foreground-secondary` color, which together read as washed-out gray icons in
 * the toolbar. Header buttons want crisp, solid icons, so we override both the
 * icon opacity and the inherited `currentColor` here.
 */
export const CHAT_HEADER_ICON_STRENGTH_CLASS_NAME =
  "text-[var(--color-text-foreground)] [&_svg]:!opacity-100";

/** Fixed control height + radius for every header toolbar control; `squircle` turns the
 *  radius into continuous corners where supported and keeps it as the fallback. */
export const CHAT_HEADER_CONTROL_CLASS_NAME = "!h-7 shrink-0 rounded-lg squircle";

/** Idle text tone for flat header/dock controls (toggles, tabs, chrome icon buttons). */
export const CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME =
  "text-[var(--color-text-foreground-secondary)]";

/** Active/pressed flat background shared by header toggles and dock tabs. */
export const CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME =
  "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]";

/** Hover treatment for idle flat surface controls. */
export const CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME =
  "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]";

/**
 * Shared flat "chip" skin for the header diff toggle and the right-dock tabs so
 * the two read as the exact same control: 28px tall, lg radius, no border, ui-sm
 * muted text that brightens + fills on hover, with a smooth color transition.
 * The active (pressed/selected) background is layered on per call site because
 * the mechanism differs (Toggle `data-pressed` vs the dock tab's `active` flag),
 * but both resolve to `--color-background-button-secondary`.
 */
export const CHAT_SURFACE_CHIP_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "gap-1.5 border-0 px-1.5 text-ui-sm font-normal transition-colors",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
);

/**
 * Geometry shared by every chip glyph, muting excluded. Status glyphs (a pull
 * request's state, say) carry meaning in their color and want this one: fading
 * them washes the signal out, which is exactly what a chrome icon wants and a
 * status icon never does.
 */
export const CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME = "size-3.5 shrink-0";

/**
 * Icon treatment shared by every chrome chip glyph (the header diff toggle + the
 * dock tabs) so size and muted strength stay identical. Color rides `currentColor`,
 * which both chips drive to `--color-text-foreground-secondary` at rest, so the
 * tint is inherited from the chip instead of redeclared per call site.
 */
export const CHAT_SURFACE_CHIP_ICON_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME,
  "opacity-70",
);

/** Renders any chip glyph with the shared {@link CHAT_SURFACE_CHIP_ICON_CLASS_NAME} treatment. */
export function SurfaceChipIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return <Icon aria-hidden className={cn(CHAT_SURFACE_CHIP_ICON_CLASS_NAME, className)} />;
}

/** Header diff toggle — shared chip skin + Toggle's pressed text treatment. */
export const CHAT_HEADER_TOGGLE_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_CLASS_NAME,
  "data-pressed:text-[var(--color-text-foreground)]",
);

/** Flat dock tab chip — shares the header diff toggle chrome, but adds one extra
 *  step of right padding (`px-1.5` → `pr-2.5`) so the label/trailing edge has a
 *  touch more breathing room than the symmetric chip base. */
export const DOCK_TAB_CHIP_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_CLASS_NAME,
  "inline-flex min-w-0 items-center pr-2.5",
);

/** Icon slot for dock tabs — bare larger icon at rest; on hover a circular disc + X appears.
 *  Color is muted while the tab (not the close button) is hovered and brightens to full
 *  foreground on direct hover of the close button so the X reads as interactive. */
export const DOCK_TAB_ICON_SLOT_CLASS_NAME =
  "relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent text-[var(--color-text-foreground-secondary)] transition-colors group-hover/dock-tab:bg-[var(--color-background-button-secondary-hover)] group-focus-within/dock-tab:bg-[var(--color-background-button-secondary-hover)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]";

/** Dock-only extra: fade the resting glyph out so the hover X can swap in.
 *  Layered on top of {@link SurfaceChipIcon}'s shared size/strength. */
export const DOCK_TAB_ICON_HOVER_HIDE_CLASS_NAME =
  "transition-opacity group-hover/dock-tab:opacity-0 group-focus-within/dock-tab:opacity-0";

/** Hover glyph: thicker X centered inside the disc. */
export const DOCK_TAB_CLOSE_GLYPH_CLASS_NAME =
  "absolute size-3.5 shrink-0 opacity-0 transition-opacity group-hover/dock-tab:opacity-100 group-focus-within/dock-tab:opacity-100";

/** Trailing close button for content tabs: a 24px target overlaid on the chip's end with
 *  its own hover disc, so it reads as separate from the (already filled) chip behind it. */
const SURFACE_TAB_TRAILING_CLOSE_CLASS_NAME =
  "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-[var(--color-text-foreground-secondary)] outline-none transition-[opacity,background-color,color] hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-ring/60";

/** Keyboard focus ring for a chip's select button (the chip itself carries no focus). */
const SURFACE_TAB_SELECT_FOCUS_CLASS_NAME =
  "outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset";

/** Marks the selected chip so {@link SurfaceTabStrip} can keep it scrolled into view. */
const SURFACE_TAB_ACTIVE_SELECTOR = "[data-surface-tab-active]";

/**
 * Shared flat tab chip for every chat surface that renders a row of closable tabs —
 * the right-dock tab strip, the open-thread strip in the chat header, the editor rail,
 * and both terminal tab bars (pane-local tabs + workspace group tabs).
 *
 * Two close treatments share the chip skin:
 * - `closePlacement="icon"` (default, compact tool tabs): hovering or focusing within
 *   the chip fades {@link icon} out and reveals a circular close affordance in its slot.
 * - `closePlacement="trailing"` (content tabs whose identity lives in the icon, such as
 *   a thread's provider): the icon stays put and a trailing X sits over the chip's end,
 *   always on the active chip and on hover/focus elsewhere. The label only gives up room
 *   for it while it shows, and fades out instead of ending in an ellipsis. The whole chip
 *   is the select target, so a wide tab is clickable edge to edge.
 * Either way the close control only renders when an {@link onClose} handler is supplied,
 * and a middle click closes the tab like a browser tab.
 *
 * The hover wiring is driven entirely by the `group/dock-tab` named group the chip
 * declares here, so it lives in exactly one place. Call sites that hand-rolled the chip
 * previously drifted to a mismatched group name (`group/tab`), which silently broke the
 * reveal — funneling them through this component makes that class of bug unrepresentable.
 *
 * `leading`/`trailing` flank the truncating label (e.g. an activity indicator or a
 * tab count badge); `labelClassName` lets a call site cap the label width.
 *
 * `sortable` makes the chip a drag-to-reorder item of a dnd-kit sortable strip.
 */
export function SurfaceTabChip({
  icon,
  label,
  active,
  title,
  leading,
  trailing,
  className,
  labelClassName,
  closeLabel,
  closePlacement,
  selectionAria,
  onSelect,
  onClose,
  onLabelDoubleClick,
  onContextMenu,
  sortable,
}: {
  icon: ReactNode;
  label: ReactNode;
  active?: boolean | undefined;
  title?: string | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string | undefined;
  labelClassName?: string | undefined;
  closeLabel?: string | undefined;
  closePlacement?: "icon" | "trailing" | undefined;
  // Tool toggles announce selection as pressed; navigation tabs (one per route) as the
  // current page.
  selectionAria?: "pressed" | "current" | undefined;
  onSelect?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  onLabelDoubleClick?: (() => void) | undefined;
  /** Opens the tab's own menu at the pointer, in place of the default context menu. */
  onContextMenu?: ((position: { x: number; y: number }) => void) | undefined;
  // Pointer activators only: dnd-kit's `attributes` would put a second role and tab stop
  // on a chip whose buttons already carry them, and advertise a keyboard drag.
  sortable?:
    | {
        setNodeRef: (node: HTMLElement | null) => void;
        style: CSSProperties;
        listeners: DraggableSyntheticListeners;
      }
    | undefined;
}) {
  const trailingClose = closePlacement === "trailing";
  const handleClose = (event: MouseEvent) => {
    event.stopPropagation();
    onClose?.();
  };
  // `relative` lets a call site overlay a second glyph on the slot (the reorder grip).
  const glyph = (
    <span className="relative flex size-4 shrink-0 items-center justify-center">{icon}</span>
  );
  const labelClassNames = cn(
    "flex min-w-0 items-center gap-1.5 text-left",
    // Content tabs carry a title rather than a tool name, so they get a roomier chip.
    trailingClose &&
      cn(
        "flex-1 gap-2 self-stretch rounded-[inherit] pl-2.5",
        // Room for the overlaid X only while it shows.
        !onClose
          ? "pr-2.5"
          : active
            ? "pr-8"
            : "pr-2.5 group-focus-within/dock-tab:pr-8 group-hover/dock-tab:pr-8",
      ),
    labelClassName,
  );
  const labelContent = (
    <>
      {trailingClose ? glyph : null}
      {leading}
      <span className={trailingClose ? "min-w-0 flex-1 truncate-fade truncate-fade-4" : "truncate"}>
        {label}
      </span>
      {trailing}
    </>
  );

  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      {...sortable?.listeners}
      data-surface-tab=""
      data-surface-tab-active={active ? "" : undefined}
      className={cn(
        // `relative` anchors the strip's between-tab divider (see SurfaceTabStrip).
        "group/dock-tab relative [-webkit-app-region:no-drag]",
        trailingClose
          ? cn(
              CHAT_SURFACE_CHIP_CLASS_NAME,
              "relative flex !h-8 min-w-0 items-center rounded-md px-0 squircle",
            )
          : DOCK_TAB_CHIP_CLASS_NAME,
        active && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
        className,
      )}
      onMouseDown={
        onClose
          ? (event) => {
              // Suppress middle-button autoscroll/paste before auxclick closes the tab.
              if (event.button === 1) event.preventDefault();
            }
          : undefined
      }
      onAuxClick={
        onClose
          ? (event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              handleClose(event);
            }
          : undefined
      }
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              onContextMenu({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      {trailingClose ? null : onClose ? (
        <button
          type="button"
          className={DOCK_TAB_ICON_SLOT_CLASS_NAME}
          aria-label={closeLabel}
          title={closeLabel}
          onPointerDown={sortable ? (event) => event.stopPropagation() : undefined}
          onClick={handleClose}
        >
          <span
            className={cn("flex items-center justify-center", DOCK_TAB_ICON_HOVER_HIDE_CLASS_NAME)}
          >
            {icon}
          </span>
          <CentralIcon name="cross-small" className={DOCK_TAB_CLOSE_GLYPH_CLASS_NAME} />
        </button>
      ) : (
        glyph
      )}
      {onSelect ? (
        <button
          type="button"
          className={cn(labelClassNames, SURFACE_TAB_SELECT_FOCUS_CLASS_NAME)}
          title={title}
          {...(selectionAria === "current"
            ? { "aria-current": active ? ("page" as const) : undefined }
            : { "aria-pressed": active })}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          onDoubleClick={onLabelDoubleClick}
        >
          {labelContent}
        </button>
      ) : (
        // Non-selectable chips (a lone tab that cannot switch to anything) render the
        // label as static text so keyboard/AT users don't land on a button that does
        // nothing.
        <span className={labelClassNames} title={title}>
          {labelContent}
        </span>
      )}
      {trailingClose && onClose ? (
        <button
          type="button"
          className={cn(
            SURFACE_TAB_TRAILING_CLOSE_CLASS_NAME,
            // Hidden but still hit-testable for a mouse: it always hovers (revealing it)
            // before clicking, and after a close slides the next tab under the cursor the
            // browser can lag a frame in re-evaluating :hover — a rapid second click must
            // still close that tab rather than fall through and select it. A touch has no
            // hover, so a tap on the hidden X selects the tab instead.
            active
              ? "opacity-100"
              : "opacity-0 group-focus-within/dock-tab:opacity-100 group-hover/dock-tab:opacity-100 pointer-coarse:pointer-events-none",
          )}
          aria-label={closeLabel}
          title={closeLabel}
          onPointerDown={sortable ? (event) => event.stopPropagation() : undefined}
          onClick={handleClose}
        >
          <CentralIcon name="cross-small" className="size-4 shrink-0" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Horizontal scroller shared by every row of {@link SurfaceTabChip}s. It hides the
 * scrollbar, softly fades whichever edge still has tabs hidden behind it (`scroll-fade-x`
 * is scroll-driven, so a strip whose tabs fit shows no fade at all), keeps the active
 * chip in view when the selection changes or the strip is resized, and lets a vertical
 * mouse wheel scroll it sideways. Pass the active tab's id as {@link activeKey};
 * {@link dividers} draws the top-bar hairline between adjacent tabs.
 */
export function SurfaceTabStrip({
  activeKey,
  dividers,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  activeKey?: string | null | undefined;
  dividers?: boolean | undefined;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  // A tab selected past the visible edge (opened elsewhere, or appended at the end) must
  // come into view or the switch looks like it did nothing. Resizes (the window or the
  // right dock narrowing the strip) and tabs opening or closing around it re-run it, since
  // both move the active tab without changing the selection.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeKey === null || activeKey === undefined) {
      return;
    }
    const revealActiveTab = () => {
      const activeTab = strip.querySelector<HTMLElement>(SURFACE_TAB_ACTIVE_SELECTOR);
      if (activeTab) {
        scrollTabIntoView(strip, activeTab);
      }
    };
    // No reveal in this commit: reading tab geometry here would force a synchronous layout
    // of everything the switch just changed (a whole chat, for the thread tabs). A fresh
    // observer always reports its target once, after the layout of the frame that paints
    // the selection, so the first reveal rides that.
    const resizeObserver = new ResizeObserver(revealActiveTab);
    resizeObserver.observe(strip);
    const mutationObserver = new MutationObserver(revealActiveTab);
    mutationObserver.observe(strip, { childList: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [activeKey]);

  // Wheel mice only emit vertical deltas; route them sideways while the strip overflows.
  // The listener stays passive: a cancelable one makes every wheel event, sideways trackpad
  // swipes included, wait for the main thread, so the strip stalls whenever a chat is
  // rendering. Events that carry a sideways delta are a trackpad gesture the browser is
  // already scrolling; adding their vertical drift on top would fight it.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return;
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: true });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={stripRef}
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-contain [scrollbar-width:none] scroll-fade-x [--scroll-fade-size:1.5rem] [&::-webkit-scrollbar]:hidden",
        dividers && "surface-tab-dividers",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const CHAT_HEADER_ICON_CONTROL_CLASS_NAME =
  "!size-7 shrink-0 rounded-lg squircle [&_svg,&_[data-slot=central-icon]]:mx-0";

/**
 * Square chrome icon-button footprint shared by every right-dock header — the tab
 * strip controls (add/collapse) and each pane's title-bar actions (close/refresh/…).
 * Aliases {@link CHAT_HEADER_ICON_CONTROL_CLASS_NAME} so dock header buttons stay the
 * same 28px size as the chat header instead of drifting to 24px (icon-xs) per surface.
 */
export const DOCK_HEADER_ICON_BUTTON_CLASS = CHAT_HEADER_ICON_CONTROL_CLASS_NAME;

/** Flatten the trailing edge of a split-button's leading control so it butts up
 *  against the shared divider (drops the end radius + the doubled end border). */
export const CHAT_HEADER_SPLIT_LEADING_CLASS_NAME = "rounded-e-none border-e-0";

/** Flatten the leading edge of a split-button's trailing (chevron) control. */
export const CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME = "rounded-s-none border-s-0";

/**
 * Container for a header split-button: a leading action, the shared
 * {@link ChatHeaderSplitDivider}, and a trailing menu trigger, all sharing one
 * rounded chrome footprint. Used by the git action control and the editor picker
 * so both split buttons look identical.
 */
export function ChatHeaderSplitGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex items-stretch", className)}>
      {children}
    </div>
  );
}

/** Hairline separator between a split-button's leading and trailing controls. */
export function ChatHeaderSplitDivider() {
  return <div aria-hidden="true" className="w-px self-stretch bg-border" />;
}

/** Short hairline between groups of header controls (actions | panel toggles): the same
 *  top-bar mark as the rail header divider and the divider between tabs. */
export function ChatHeaderGroupDivider() {
  return (
    <div
      aria-hidden="true"
      className="h-(--app-chrome-divider-height) w-px shrink-0 bg-(--app-chrome-divider-color)"
    />
  );
}

export type DiffRenderMode = "stacked" | "split";

/** Visual treatment shared across the header row. `surface` is the quiet icon-only
 *  look of the panel toggles (muted glyph at rest, filled on hover), for icon buttons
 *  that sit in the same cluster. */
export type ChatHeaderControlTone = "plain" | "outline" | "surface";

/** Maps a header tone onto the shared Button variant taxonomy. */
export function chatHeaderControlVariant(
  tone: ChatHeaderControlTone,
): NonNullable<ComponentProps<typeof Button>["variant"]> {
  return tone === "outline" ? "chrome-outline" : "chrome";
}

/** Glyph strength for a tone: surface buttons dim their glyph exactly like
 *  {@link SurfaceChipIcon} so they match the Toggle chips beside them. */
function chatHeaderIconStrengthClassName(tone: ChatHeaderControlTone): string {
  return tone === "surface"
    ? cn(
        CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
        "[&_[data-slot=central-icon]]:!opacity-70 [&_svg]:!size-4 [&_svg]:!opacity-70 [&_[data-slot=central-icon]]:!size-4",
      )
    : CHAT_HEADER_ICON_STRENGTH_CLASS_NAME;
}

type ChatHeaderButtonBaseProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  tone?: ChatHeaderControlTone;
};

/**
 * Text (or text + icon) header control. Safe to use directly or as a
 * Menu/Tooltip `render` target since it forwards the ref and spreads props.
 */
export const ChatHeaderButton = forwardRef<HTMLButtonElement, ChatHeaderButtonBaseProps>(
  function ChatHeaderButton({ tone: toneProp, className, ...props }, ref) {
    const tone = toneProp ?? "outline";
    return (
      <Button
        {...props}
        ref={ref}
        size="xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(
          CHAT_HEADER_CONTROL_CLASS_NAME,
          CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
          className,
        )}
      />
    );
  },
);

type ChatHeaderIconButtonBaseProps = Omit<
  ComponentProps<typeof Button>,
  "variant" | "size" | "aria-label"
> & {
  label: string;
  tone?: ChatHeaderControlTone;
  children?: ReactNode;
};

/**
 * Square icon-only header control. Renders only a Button (no built-in tooltip)
 * so it composes with the existing Tooltip/Menu `render` wrappers used in the header.
 */
export const ChatHeaderIconButton = forwardRef<HTMLButtonElement, ChatHeaderIconButtonBaseProps>(
  function ChatHeaderIconButton({ label, tone: toneProp, className, children, ...props }, ref) {
    const tone = toneProp ?? "plain";
    return (
      <Button
        {...props}
        ref={ref}
        aria-label={label}
        size="icon-xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(
          CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
          chatHeaderIconStrengthClassName(tone),
          className,
        )}
      >
        {children}
      </Button>
    );
  },
);

/** State for the right-side surface panel toggles (Group panel, Library panel). */
export interface SurfacePanelToggleState {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Amber needs-you dot: at least one member thread is waiting on the user. */
  readonly attention?: boolean;
}

const SURFACE_PANEL_TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
);

/** Header chip that opens/closes a right-side surface panel — the shared form of
 *  what used to be identical ProjectToggle/LibraryToggle implementations. */
export function SurfacePanelToggle({
  state,
  icon,
  ariaLabel,
  tooltip,
}: {
  state: SurfacePanelToggleState;
  icon: LucideIcon;
  ariaLabel: string;
  tooltip: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={SURFACE_PANEL_TOGGLE_CLASS_NAME}
            pressed={state.open}
            onPressedChange={state.onOpenChange}
            aria-label={state.attention ? `${ariaLabel}, needs attention` : ariaLabel}
            variant="default"
            size="xs"
          >
            <SurfaceChipIcon icon={icon} className="size-4" />
            {state.attention ? (
              <span
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500 dark:bg-amber-300/90"
                aria-hidden
              />
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
