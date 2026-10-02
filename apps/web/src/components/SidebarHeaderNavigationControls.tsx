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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number; animate: boolean } | null>(null);
  const registerAnchor = useCallback<RegisterLeadingControlsAnchor>((element) => {
    setAnchor(element);
    return () => setAnchor((current) => (current === element ? null : current));
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
            railSlot.getBoundingClientRect().right
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
      {children}
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
    </LeadingControlsDockContext.Provider>
  );
}

// Empty box with the cluster's exact footprint; the dock paints the real cluster over it.
function SidebarLeadingControlsAnchor({ register }: { register: RegisterLeadingControlsAnchor }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? register(ref.current) : undefined), [register]);

  return (
    <div ref={ref} aria-hidden className={LEADING_CONTROLS_CLASS}>
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
 * collapsed, or mobile where the drawer floats over content). When the sidebar is open on
 * desktop the strip owns the cluster's box, so this renders nothing.
 */
export function SidebarHeaderNavigationControls() {
  const { isMobile, open } = useSidebar();

  if (!isMobile && open) {
    return null;
  }

  return <SidebarLeadingControlsSlot />;
}
