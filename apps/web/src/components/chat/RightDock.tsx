import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { useIsMobile } from "~/hooks/useMediaQuery";
import {
  type DockPaneRuntimeMode,
  EMPTY_PANE_ID_SET,
  reconcileKeepMountedPaneIds,
} from "~/lib/dockPaneActivation";
import { LayoutRightIcon, PanelCollapseIcon, PanelExpandIcon, PlusSignIcon } from "~/lib/icons";
import type {
  RightDockPane,
  RightDockPaneKind,
  RightDockThreadState,
} from "~/rightDockStore.logic";
import { resolveActivePane } from "~/rightDockStore.logic";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  Sidebar,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS,
  SidebarProvider,
  SidebarRail,
} from "../ui/sidebar";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "./chatHeaderControls";
import { SurfaceContentTabs } from "./SurfaceContentTabs";
import {
  getRightDockPaneMeta,
  type RightDockLauncherItem,
  resolveRightDockPaneIcon,
  resolveRightDockPaneLabel,
} from "./rightDockPaneMeta";
import { useDesktopTopBarWindowControlsGutterClassName } from "~/hooks/useDesktopTopBarGutter";

// Pane kinds whose content has a natural width, opened at that size rather than
// at the even split. The device pane frames a portrait phone, so its useful
// width is whatever lets the phone reach full height: a ~19.5:9 chassis stays
// height-bound well past 480px, and opening narrower only shrinks the device
// while leaving empty space above and below it.
const RIGHT_DOCK_PREFERRED_WIDTH: Partial<Record<RightDockPaneKind, number>> = {
  device: 38 * 16,
};

interface RightDockProps {
  state: RightDockThreadState;
  minWidth: number;
  defaultWidth: string;
  /** Share of the shell the dock takes each time it opens. The chat thread dock is an even
   *  split (the default, 0.5); a host whose dock is a side companion can open it narrower. */
  openWidthFraction?: number;
  shouldAcceptWidth: (context: { nextWidth: number; wrapper: HTMLElement }) => boolean;
  paneLabelOverrides?: Record<string, string | undefined>;
  // Per-pane tab glyph overrides (same shape as label overrides) — e.g. a pull request pane swapping the generic kind icon for its live state glyph.
  paneIconOverrides?: Record<string, ReactNode | undefined>;
  addMenuKinds: readonly RightDockPaneKind[];
  launcherItems?: readonly RightDockLauncherItem[];
  /** A plain "+" for hosts whose only addable thing is one kind (no menu to choose from). */
  addAction?: { label: string; onClick: () => void };
  // Single-pane hosts omit selection so their lone tab label is static; multi-pane chat hosts
  // provide the callback and keep the normal selectable-tab behavior.
  onSelectPane?: ((paneId: string) => void) | undefined;
  onClosePane: (paneId: string) => void;
  /** Drops a dragged tab onto another tab's slot. Hosts that omit it get fixed tabs. */
  onMovePane?: ((paneId: string, overPaneId: string) => void) | undefined;
  onCollapse: () => void;
  onOpenChange: (open: boolean) => void;
  onAddPane: (kind: RightDockPaneKind) => void;
  motionKey?: string;
  activePaneRuntimeMode?: DockPaneRuntimeMode;
  browserRuntimeMode?: DockPaneRuntimeMode;
  renderPane: (
    pane: RightDockPane,
    context: {
      runtimeMode: DockPaneRuntimeMode;
      isActive: boolean;
      isVisible: boolean;
    },
  ) => ReactNode;
}

function RightDockLauncher(props: {
  items: readonly RightDockLauncherItem[];
  onOpen: (kind: RightDockPaneKind) => void;
}) {
  return (
    <nav
      aria-label="Open a panel"
      className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-6"
    >
      <div className="flex w-full max-w-sm flex-col gap-1.5">
        {props.items.map(({ kind, Icon, label }) => (
          <Button
            key={kind}
            variant="subtle"
            size="xl"
            className="h-11 w-full justify-start gap-3 rounded-xl px-4 text-ui-lg font-normal"
            aria-label={`Open ${label}`}
            onClick={() => props.onOpen(kind)}
          >
            <Icon className="size-4 shrink-0" />
            <span>{label}</span>
          </Button>
        ))}
      </div>
    </nav>
  );
}

// Persist which keep-mounted panes (e.g. terminals) have been activated so they
// stay in the DOM while another tab is selected, pruned to live panes so closed
// panes drop out and the set never leaks across thread switches. The set is
// The rendered set is derived synchronously so a kept pane never unmounts for a
// frame. A layout effect commits that set for the next render without mutating a
// ref during render (which is unsafe when React replays or abandons work).
function useKeepMountedPaneIds(
  panes: readonly RightDockPane[],
  activePane: RightDockPane | null,
): ReadonlySet<string> {
  const [committedPaneIds, setCommittedPaneIds] = useState<ReadonlySet<string>>(EMPTY_PANE_ID_SET);
  const activePaneId = activePane?.id ?? null;
  const activePaneKind = activePane?.kind ?? null;
  const renderedPaneIds = reconcileKeepMountedPaneIds({
    previous: committedPaneIds,
    panes,
    activePaneId,
    activePaneKind,
  });

  useLayoutEffect(() => {
    setCommittedPaneIds((current) => {
      const next = reconcileKeepMountedPaneIds({
        previous: current,
        panes,
        activePaneId,
        activePaneKind,
      });
      if (next.size === current.size && [...next].every((paneId) => current.has(paneId))) {
        return current;
      }
      return next;
    });
  }, [activePaneId, activePaneKind, panes]);

  return renderedPaneIds;
}

export function RightDock(props: RightDockProps) {
  const activePane = resolveActivePane(props.state);
  const onSelectPane = props.onSelectPane;
  const activePaneRuntimeMode = props.activePaneRuntimeMode ?? "live";
  const browserRuntimeMode = props.browserRuntimeMode ?? "live";
  // The dock is the right-most surface when open, so its header sits under the fixed Windows caption cluster — reserve the same gutter the chat header uses.
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();

  const keepMountedPaneIds = useKeepMountedPaneIds(props.state.panes, activePane);
  // The dock must open as an exact share of the chat shell (half by default). The
  // CSS default can only approximate it (it cannot observe the resizable left
  // sidebar), so on every open we measure the shell row hosting chat + dock and
  // pin the dock width to exactly that share. Mid-session drags still resize
  // freely; the next open restores the share.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expansionKey = props.motionKey ?? "dock";
  const isMobile = useIsMobile();
  const maximized = !isMobile && props.state.open && expandedKey === expansionKey;
  const [expandedWidth, setExpandedWidth] = useState(0);
  useLayoutEffect(() => {
    if (maximized && props.state.panes.length === 0) {
      setExpandedKey(null);
      props.onCollapse();
    }
  }, [maximized, props.state.panes.length, props.onCollapse]);
  useLayoutEffect(() => {
    if (!maximized) return;
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shell = wrapper?.parentElement;
    if (!shell || !wrapper) return;
    const update = () => setExpandedWidth(shell.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    // The chat stays mounted and running underneath, but must leave tab order.
    const siblings = Array.from(shell.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== wrapper,
    );
    const previous = siblings.map((element) => ({
      inert: element.inert,
      visibility: element.style.visibility,
    }));
    siblings.forEach((element) => {
      element.inert = true;
      // Electron drag regions can intercept clicks through an overlapping panel. Hide the covered surface as well as removing it from keyboard navigation.
      element.style.visibility = "hidden";
    });
    return () => {
      observer.disconnect();
      siblings.forEach((element, index) => {
        element.inert = previous[index]?.inert ?? false;
        element.style.visibility = previous[index]?.visibility ?? "";
      });
    };
  }, [maximized]);
  useEffect(() => {
    if (!props.state.open) setExpandedKey(null);
  }, [props.state.open]);
  const minWidth = props.minWidth;
  const openWidthFraction = props.openWidthFraction ?? 0.5;
  const activePaneKind = activePane?.kind ?? null;
  useEffect(() => {
    if (!props.state.open) {
      return;
    }
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shell = wrapper?.parentElement;
    if (!wrapper || !shell) {
      return;
    }
    // A phone-shaped pane has a natural width: half the shell leaves the device stranded in empty space, so kinds that render a fixed-aspect object open at their own comfortable size instead of the even split.
    const preferredWidth = activePaneKind ? RIGHT_DOCK_PREFERRED_WIDTH[activePaneKind] : undefined;
    const openWidth =
      preferredWidth ?? Math.round(shell.getBoundingClientRect().width * openWidthFraction);
    if (openWidth > 0) {
      wrapper.style.setProperty("--sidebar-width", `${Math.max(minWidth, openWidth)}px`);
    }
  }, [props.state.open, minWidth, openWidthFraction, activePaneKind]);
  // Mounted in id order rather than tab order: reordering the tabs must not move a pane's
  // DOM node, which would reload an embedded frame (the panes overlap, so order is unseen).
  const renderedPanes = props.state.panes
    .filter((pane) => pane.id === activePane?.id || keepMountedPaneIds.has(pane.id))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Motion allowance keyed to the current motionKey: a key change (reposition/
  // remount) derives straight back to "suppressed" in that same render, and the
  // rAF below re-enables motion once the suppressed frame has painted. Mounting
  // with the dock open starts suppressed for the same reason.
  const [motionState, setMotionState] = useState<{
    key: RightDockProps["motionKey"];
    allow: boolean;
  }>(() => ({ key: props.motionKey, allow: !props.state.open }));
  const shouldSuppressChromeMotion = !(motionState.key === props.motionKey && motionState.allow);

  useEffect(() => {
    if (!shouldSuppressChromeMotion) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      setMotionState({ key: props.motionKey, allow: true });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [props.motionKey, shouldSuppressChromeMotion]);

  // smooth drawer easing — ease-linear reads stepped on the wide dock; applied to both width gap and sliding container so they stay in lockstep
  const chromeMotionClass = shouldSuppressChromeMotion
    ? SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS
    : SIDEBAR_OFFCANVAS_MOTION_CLASS;

  return (
    <SidebarProvider
      defaultOpen={false}
      open={props.state.open}
      onOpenChange={props.onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": props.defaultWidth } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className={cn(
          "border-l border-[var(--app-surface-divider)] text-foreground",
          chromeMotionClass,
        )}
        style={maximized ? { width: expandedWidth || undefined, zIndex: 30 } : undefined}
        data-dock-maximized={maximized ? "true" : undefined}
        innerClassName={CHAT_BACKGROUND_CLASS_NAME}
        gapClassName={chromeMotionClass}
        transparentSurface
        rail={!maximized && <SidebarRail />}
        resizable={{
          minWidth: props.minWidth,
          shouldAcceptWidth: props.shouldAcceptWidth,
        }}
      >
        <div
          ref={contentRef}
          data-right-dock-content
          className="flex h-full min-h-0 w-full flex-col"
        >
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "gap-1 px-1.5 [-webkit-app-region:no-drag]",
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <SurfaceContentTabs
              ariaLabel="Open panels"
              activeKey={props.state.activePaneId}
              onMove={props.onMovePane}
              tabs={props.state.panes.map((pane) => ({
                key: pane.id,
                title: resolveRightDockPaneLabel(pane, props.paneLabelOverrides),
                icon: props.paneIconOverrides?.[pane.id] ?? resolveRightDockPaneIcon(pane),
                onSelect: onSelectPane ? () => onSelectPane(pane.id) : undefined,
                onClose: () => props.onClosePane(pane.id),
              }))}
            />
            {props.state.panes.length > 0 && props.addMenuKinds.length > 0 ? (
              <Menu modal={false}>
                <MenuTrigger
                  render={
                    <Button
                      variant="chrome"
                      size="icon-xs"
                      aria-label="Add panel"
                      title="Add panel"
                      className={DOCK_HEADER_ICON_BUTTON_CLASS}
                    />
                  }
                >
                  <PlusSignIcon className="size-4" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
                  {props.addMenuKinds.map((kind) => {
                    const { Icon, label } = getRightDockPaneMeta(kind);
                    return (
                      <MenuItem key={kind} onClick={() => props.onAddPane(kind)}>
                        <Icon className="size-3.5 shrink-0" />
                        <span>{label}</span>
                      </MenuItem>
                    );
                  })}
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}
            {props.state.panes.length > 0 && props.addMenuKinds.length === 0 && props.addAction ? (
              <IconButton
                variant="chrome"
                size="icon-xs"
                label={props.addAction.label}
                tooltip={props.addAction.label}
                tooltipSide="bottom"
                className={DOCK_HEADER_ICON_BUTTON_CLASS}
                onClick={props.addAction.onClick}
              >
                <PlusSignIcon className="size-3.5" />
              </IconButton>
            ) : null}
            {!isMobile && (maximized || activePane !== null) ? (
              <IconButton
                variant="chrome"
                size="icon-xs"
                label={maximized ? "Restore panel" : "Maximize panel"}
                tooltip={maximized ? "Restore panel" : "Maximize panel"}
                tooltipSide="bottom"
                aria-pressed={maximized}
                className={DOCK_HEADER_ICON_BUTTON_CLASS}
                onClick={() => setExpandedKey(maximized ? null : expansionKey)}
              >
                {maximized ? (
                  <PanelCollapseIcon className="size-4" />
                ) : (
                  <PanelExpandIcon className="size-4" />
                )}
              </IconButton>
            ) : null}
            <IconButton
              variant="chrome"
              size="icon-xs"
              label="Collapse panel"
              tooltip="Collapse panel"
              tooltipSide="bottom"
              className={DOCK_HEADER_ICON_BUTTON_CLASS}
              onClick={props.onCollapse}
            >
              <LayoutRightIcon className="size-4" />
            </IconButton>
          </div>
          <div className="relative min-h-0 flex-1">
            {activePane === null && props.launcherItems ? (
              <RightDockLauncher items={props.launcherItems} onOpen={props.onAddPane} />
            ) : null}
            {renderedPanes.map((pane) => {
              const isActive = pane.id === activePane?.id;
              const isVisible = isActive && props.state.open;
              // Keep-mounted panes that are not the active tab are already hydrated; browser panes may use an explicit runtime mode so a floating browser can own the live guest while the dock stays preview-only.
              const runtimeMode: DockPaneRuntimeMode =
                pane.kind === "browser"
                  ? browserRuntimeMode
                  : isActive
                    ? activePaneRuntimeMode
                    : "live";
              return (
                <div
                  key={pane.id}
                  className={cn(
                    "absolute inset-0 flex min-h-0 w-full",
                    isActive ? undefined : "invisible pointer-events-none",
                  )}
                  aria-hidden={isVisible ? undefined : true}
                  inert={isVisible ? undefined : true}
                  data-native-browser-surface={
                    pane.kind === "browser" && isActive && runtimeMode === "live"
                      ? "true"
                      : undefined
                  }
                >
                  {props.renderPane(pane, { runtimeMode, isActive, isVisible })}
                </div>
              );
            })}
          </div>
        </div>
      </Sidebar>
    </SidebarProvider>
  );
}

export default RightDock;
