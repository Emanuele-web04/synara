// FILE: SidebarHeaderNavigationControls.tsx
// Purpose: Single source for the leading chrome cluster (sidebar toggle + route arrows).
// Layer: Shared web shell chrome
// Depends on: Sidebar state plus AppNavigationButtons

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { isElectron } from "~/env";
import { AppNavigationButtons } from "./AppNavigationButtons";
import { SIDEBAR_OFFCANVAS_MOTION_CLASS, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { cn } from "~/lib/utils";

const LEADING_CONTROLS_CLASS = "flex shrink-0 items-center gap-0.5";

/**
 * The leading chrome cluster: the sidebar toggle followed by the route nav arrows.
 *
 * Keeping it in ONE component is what keeps every place it shows visually identical:
 * same trigger tone, icon size, and gap. The wrapper layout (hidden/md:flex, ml-auto, …)
 * varies per host, so it is passed in via `className`; the inner controls stay constant.
 */
export function SidebarLeadingControls({ className }: { className?: string }) {
  return (
    <div className={cn(LEADING_CONTROLS_CLASS, className)}>
      <SidebarTrigger
        className="size-7 shrink-0 text-muted-foreground/75 hover:text-foreground"
        aria-label="Toggle thread sidebar"
      />
      <AppNavigationButtons className="ms-0" />
    </div>
  );
}

// A route top bar eases its leading padding along with the panel (see `.app-top-bar` in
// index.css), so a box measured as the toggle lands is still short of where it settles.
function pendingLeadingPaddingShift(anchor: HTMLElement, boundary: HTMLElement): number {
  let shift = 0;
  for (
    let element = anchor.parentElement;
    element && element !== boundary;
    element = element.parentElement
  ) {
    for (const animation of element.getAnimations?.() ?? []) {
      if (
        !(animation instanceof CSSTransition) ||
        animation.transitionProperty !== "padding-left" ||
        !(animation.effect instanceof KeyframeEffect)
      ) {
        continue;
      }
      const settled = Number.parseFloat(
        String(animation.effect.getKeyframes().at(-1)?.paddingLeft),
      );
      const current = Number.parseFloat(getComputedStyle(element).paddingLeft);
      if (Number.isFinite(settled) && Number.isFinite(current)) {
        shift += settled - current;
      }
    }
  }
  return shift;
}

type RegisterLeadingControlsAnchor = (element: HTMLElement) => () => void;

const LeadingControlsDockContext = createContext<RegisterLeadingControlsAnchor | null>(null);

/**
 * Desktop shell owner of the cluster. The strip over the open panel and the route header
 * of a collapsed one each reserve the cluster's box with a {@link SidebarLeadingControlsSlot};
 * the dock paints the one real cluster over whichever box is mounted. Toggling the panel
 * therefore never remounts the buttons, and they do not ride the route column's slide:
 * the dock targets the box's settled position, not the one it has mid-transition.
 *
 * `routeColumn` is the element that slides with the panel, and `railSlot` the fixed rail
 * whose right edge is where that column settles once the panel is collapsed.
 */
export function SidebarLeadingControlsDock({
  routeColumn,
  railSlot,
  children,
}: {
  routeColumn: HTMLElement | null;
  railSlot: HTMLElement | null;
  children: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const anchors = useRef(new Set<HTMLElement>());
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number; animate: boolean } | null>(null);
  const registerAnchor = useCallback<RegisterLeadingControlsAnchor>((element) => {
    const selectLeadingAnchor = () => {
      // Split panes reserve several boxes; shell chrome belongs to the first header.
      let leading: HTMLElement | null = null;
      for (const candidate of anchors.current) {
        if (
          !leading ||
          candidate.compareDocumentPosition(leading) & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          leading = candidate;
        }
      }
      setAnchor(leading);
    };
    anchors.current.add(element);
    selectLeadingAnchor();
    return () => {
      anchors.current.delete(element);
      selectLeadingAnchor();
    };
  }, []);

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const x =
        routeColumn && railSlot && routeColumn.contains(anchor)
          ? rect.left -
            routeColumn.getBoundingClientRect().left +
            railSlot.getBoundingClientRect().right +
            pendingLeadingPaddingShift(anchor, routeColumn)
          : rect.left;
      const y = rect.top;
      setPosition((current) =>
        current && current.x === x && current.y === y ? current : { x, y, animate: !!current },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, railSlot, routeColumn]);

  // Phones keep the cluster inside the host header (the drawer floats over content).
  const contextValue = useMemo(
    () => (isMobile ? null : registerAnchor),
    [isMobile, registerAnchor],
  );

  return (
    <LeadingControlsDockContext.Provider value={contextValue}>
      {/* Fixed painting must not put the leading controls after route content in tab order. */}
      {!isMobile && position ? (
        <div
          className={cn(
            "fixed top-0 left-0 z-30 font-system-ui [-webkit-app-region:no-drag]",
            // Where the two boxes differ (no traffic-light gutter), glide with the panel.
            position.animate &&
              cn(
                "transition-transform motion-reduce:transition-none",
                SIDEBAR_OFFCANVAS_MOTION_CLASS,
              ),
          )}
          style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
        >
          <SidebarLeadingControls />
        </div>
      ) : null}
      {children}
    </LeadingControlsDockContext.Provider>
  );
}

// Reserve the cluster's footprint and exclude it from the host's native drag region.
// Electron applies drag rectangles in document order, after the earlier dock's no-drag box.
function SidebarLeadingControlsAnchor({
  register,
  active = true,
}: {
  register: RegisterLeadingControlsAnchor;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (active && ref.current ? register(ref.current) : undefined),
    [active, register],
  );

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(LEADING_CONTROLS_CLASS, "[-webkit-app-region:no-drag]")}
    >
      <div className="size-7 shrink-0" />
      {isElectron ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="size-8" />
          <div className="size-8" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where a host places the cluster: a reserved box under a
 * {@link SidebarLeadingControlsDock}, the cluster itself anywhere else.
 */
export function SidebarLeadingControlsSlot() {
  const register = useContext(LeadingControlsDockContext);
  return register ? (
    <SidebarLeadingControlsAnchor register={register} />
  ) : (
    <SidebarLeadingControls />
  );
}

/**
 * Host-header variant: only appears once the strip over the panel is gone (sidebar
 * collapsed, or mobile where the drawer floats over content).
 *
 * Under a {@link SidebarLeadingControlsDock} the reserved box stays mounted and opens along
 * the inline axis in step with the panel's slide, so the title next to it glides to its new
 * offset instead of jumping there on the toggle. `collapsedGapClassName` is the negative
 * end margin that cancels the host row's flex gap while the box is closed (a zero-width
 * flex item still takes a gap); `className` pads the open box.
 */
export function SidebarHeaderNavigationControls({
  className,
  collapsedGapClassName,
}: {
  className?: string;
  collapsedGapClassName?: string;
}) {
  const { isMobile, open } = useSidebar();
  const register = useContext(LeadingControlsDockContext);
  const shown = isMobile || !open;

  if (!register) {
    return shown ? <SidebarLeadingControls {...(className ? { className } : {})} /> : null;
  }

  return (
    <div
      aria-hidden
      className={cn(
        "grid shrink-0 transition-[grid-template-columns,margin] motion-reduce:transition-none",
        SIDEBAR_OFFCANVAS_MOTION_CLASS,
        shown ? "grid-cols-[1fr]" : cn("grid-cols-[0fr]", collapsedGapClassName),
      )}
    >
      <div className="min-w-0 overflow-hidden">
        <div className={cn("w-max", className)}>
          <SidebarLeadingControlsAnchor register={register} active={shown} />
        </div>
      </div>
    </div>
  );
}
