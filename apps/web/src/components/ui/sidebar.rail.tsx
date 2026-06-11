// Purpose: The resize/toggle rail, including pointer-driven drag-to-resize logic and
//   the clamp helper.
// Layer: ui primitive (shadcn sidebar). Depends on ui/sidebar.context for instance state.
// Exports: SidebarRail.
import * as React from "react";
import { Schema } from "effect";
import { cn } from "~/lib/utils";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  type SidebarResolvedResizableOptions,
  SidebarInstanceContext,
  useSidebar,
} from "~/components/ui/sidebar.context";

function clampSidebarWidth(width: number, options: SidebarResolvedResizableOptions): number {
  return Math.max(options.minWidth, Math.min(width, options.maxWidth));
}

export function SidebarRail({
  placement = "sidebar-shell",
  className,
  onClick,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<"button"> & {
  /** `content-seam` sits on the chat column edge above the card; `sidebar-shell` stays on the sidebar container. */
  placement?: "sidebar-shell" | "content-seam";
}) {
  const { open, toggleSidebar } = useSidebar();
  const sidebarInstance = React.useContext(SidebarInstanceContext);
  const side = sidebarInstance?.side ?? "left";
  const isContentSeam = placement === "content-seam";
  const railRef = React.useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = React.useRef(false);
  const resizeStateRef = React.useRef<{
    moved: boolean;
    pointerId: number;
    pendingWidth: number;
    rail: HTMLButtonElement;
    rafId: number | null;
    sidebarRoot: HTMLElement;
    side: "left" | "right";
    startWidth: number;
    startX: number;
    transitionTargets: HTMLElement[];
    width: number;
    wrapper: HTMLElement;
  } | null>(null);
  const resolvedResizable = sidebarInstance?.resizable ?? null;
  const canResize = resolvedResizable !== null && open;
  const railLabel = canResize ? "Resize Sidebar" : "Toggle Sidebar";
  const railTitle = canResize ? "Drag to resize sidebar" : "Toggle Sidebar";

  const stopResize = React.useCallback(
    (pointerId: number) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      if (resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      resizeState.transitionTargets.forEach((element) => {
        element.style.removeProperty("transition-duration");
      });
      if (resolvedResizable?.storageKey && typeof window !== "undefined") {
        setLocalStorageItem(resolvedResizable.storageKey, resizeState.width, Schema.Finite);
      }
      resolvedResizable?.onResize?.(resizeState.width);
      resizeStateRef.current = null;
      if (resizeState.rail.hasPointerCapture(pointerId)) {
        resizeState.rail.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [resolvedResizable],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented) return;
      if (!resolvedResizable || !open || event.button !== 0) return;

      const wrapper = event.currentTarget.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
      const sidebarRoot =
        event.currentTarget.closest<HTMLElement>("[data-slot='sidebar']") ??
        wrapper?.querySelector<HTMLElement>("[data-slot='sidebar']") ??
        null;
      if (!wrapper || !sidebarRoot) {
        return;
      }

      const sidebarContainer = sidebarRoot.querySelector<HTMLElement>(
        "[data-slot='sidebar-container']",
      );
      if (!sidebarContainer) {
        return;
      }

      const startWidth = sidebarContainer.getBoundingClientRect().width;
      const initialWidth = clampSidebarWidth(startWidth, resolvedResizable);
      const transitionTargets = [
        sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
        sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-container']"),
      ].filter((element): element is HTMLElement => element !== null);
      transitionTargets.forEach((element) => {
        element.style.setProperty("transition-duration", "0ms");
      });

      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        moved: false,
        pointerId: event.pointerId,
        pendingWidth: initialWidth,
        rail: event.currentTarget,
        rafId: null,
        sidebarRoot,
        side: sidebarInstance?.side ?? "left",
        startWidth: initialWidth,
        startX: event.clientX,
        transitionTargets,
        width: initialWidth,
        wrapper,
      };
      wrapper.style.setProperty("--sidebar-width", `${initialWidth}px`);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerDown, open, resolvedResizable, sidebarInstance?.side],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerMove?.(event);
      if (event.defaultPrevented) return;
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !resolvedResizable) return;

      event.preventDefault();
      const delta =
        resizeState.side === "right"
          ? resizeState.startX - event.clientX
          : event.clientX - resizeState.startX;
      if (Math.abs(delta) > 2) {
        resizeState.moved = true;
      }
      resizeState.pendingWidth = clampSidebarWidth(
        resizeState.startWidth + delta,
        resolvedResizable,
      );
      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = resizeStateRef.current;
        if (!activeResizeState || !resolvedResizable) return;

        activeResizeState.rafId = null;
        const nextWidth = activeResizeState.pendingWidth;
        const accepted =
          resolvedResizable.shouldAcceptWidth?.({
            currentWidth: activeResizeState.width,
            nextWidth,
            rail: activeResizeState.rail,
            side: activeResizeState.side,
            sidebarRoot: activeResizeState.sidebarRoot,
            wrapper: activeResizeState.wrapper,
          }) ?? true;
        if (!accepted) {
          return;
        }

        activeResizeState.wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);
        activeResizeState.width = nextWidth;
      });
    },
    [onPointerMove, resolvedResizable],
  );

  const endResizeInteraction = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      event.preventDefault();
      suppressClickRef.current = resizeState.moved;
      stopResize(event.pointerId);
    },
    [stopResize],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerUp?.(event);
      if (event.defaultPrevented) return;
      endResizeInteraction(event);
    },
    [endResizeInteraction, onPointerUp],
  );

  const handlePointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerCancel?.(event);
      if (event.defaultPrevented) return;
      endResizeInteraction(event);
    },
    [endResizeInteraction, onPointerCancel],
  );

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        return;
      }
      if (resolvedResizable && open) {
        event.preventDefault();
        return;
      }
      toggleSidebar();
    },
    [onClick, open, resolvedResizable, toggleSidebar],
  );

  React.useEffect(() => {
    if (!resolvedResizable?.storageKey || typeof window === "undefined") return;
    const rail = railRef.current;
    if (!rail) return;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;

    const storedWidth = getLocalStorageItem(resolvedResizable.storageKey, Schema.Finite);
    if (storedWidth === null) return;
    const clampedWidth = clampSidebarWidth(storedWidth, resolvedResizable);
    wrapper.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    resolvedResizable.onResize?.(clampedWidth);
  }, [resolvedResizable]);

  React.useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current;
      if (resizeState?.rafId != null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      resizeState?.transitionTargets.forEach((element) => {
        element.style.removeProperty("transition-duration");
      });
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  return (
    <button
      aria-label={railLabel}
      className={cn(
        isContentSeam
          ? [
              /* Resize hit-area on the chat card seam. The visible divider is the card's
                 border-inline edge (follows the rounded corner); hovering this rail
                 intensifies that border via :has() in index.css — no overlay line here.
                 This rail lives OUTSIDE <Sidebar>, so `in-data-[side]` cursor variants
                 never match (no [data-side] ancestor). Set the cursor directly:
                 `col-resize` (the ↔ handle) when resizing is available — matching the
                 body cursor used during the drag — else `pointer` for the toggle. */
              "absolute inset-y-0 z-[25] hidden w-4 sm:flex",
              canResize ? "cursor-col-resize" : "cursor-pointer",
              side === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2",
            ]
          : [
              /* Legacy: rail anchored to the sidebar shell (right dock, etc.). */
              "-translate-x-1/2 group-data-[side=left]:-right-4 absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-sidebar-border group-data-[side=right]:left-0 sm:flex [[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none",
              "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
              "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
              "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full",
              "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
              "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
            ],
        className,
      )}
      data-sidebar="rail"
      data-placement={placement}
      data-slot="sidebar-rail"
      onClick={handleClick}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={railRef}
      tabIndex={-1}
      title={railTitle}
      type="button"
      {...props}
    />
  );
}
